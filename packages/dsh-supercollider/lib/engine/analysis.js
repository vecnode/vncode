/**
 * dsh-supercollider — the measurements that tell an agent what it actually made.
 *
 * ## Why this module exists
 *
 * An agent that cannot hear has exactly two ways to find out whether a patch
 * worked: ask the user, or guess. Both are bad. The failure this was written for
 * is specific and it happened: a gong model was built, the node was created, the
 * tool reported success — and what came out of the speakers was noise. Nothing in
 * the engine could tell the difference, because *"a node exists"* and *"the node
 * is a gong"* are different claims and only the second one matters.
 *
 * So the numbers here are chosen to answer the audio question, not a generic DSP
 * question:
 *
 *   - **peak** — will it clip? `>= 1.0` is clipping, and clipped modal synthesis
 *     sounds like noise, which is precisely how the gong went wrong.
 *   - **rms** — is it audible at all, or effectively silent?
 *   - **crest factor** (`peak / rms`) — is it a strike and a ring, or a wall?
 *   - **spectral flatness** — a gong or a bell is *tonal*; white noise is not.
 *     This is the one number that separates the two, and it is computed from a
 *     real DFT rather than estimated.
 *   - **dominant partials** — a bank of inharmonic modes has peaks at known
 *     frequencies; if the model was meant to ring at 62 Hz, this says whether
 *     there is energy there.
 *
 * Everything is plain arithmetic on Float64 arrays: no dependencies, and the
 * answers are comparable between runs.
 */

/** A Hann window, precomputed per length. */
const windowCache = new Map()

function hann(length) {
  const cached = windowCache.get(length)
  if (cached !== undefined) return cached
  const made = new Float64Array(length)
  for (let index = 0; index < length; index += 1) {
    made[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (length - 1)))
  }
  windowCache.set(length, made)
  return made
}

/**
 * Split an interleaved sample list into per-channel arrays.
 *
 * @param values - the interleaved floats, as `/b_setn` returned them.
 * @param channels - the channel count.
 * @returns an array of Float64Array, one per channel.
 */
export function deinterleave(values, channels) {
  const count = Math.max(1, Math.floor(channels) || 1)
  const frames = Math.floor(values.length / count)
  const out = []
  for (let channel = 0; channel < count; channel += 1) {
    const made = new Float64Array(frames)
    for (let frame = 0; frame < frames; frame += 1) made[frame] = Number(values[frame * count + channel]) || 0
    out.push(made)
  }
  return out
}

/**
 * The amplitude facts about one channel.
 *
 * @param samples - one channel.
 * @returns `{ frames, peak, peakAt, rms, dbfs, dc, clipped, clippedRatio, crest }`.
 */
export function amplitude(samples) {
  const frames = samples.length
  if (frames === 0) {
    return { frames: 0, peak: 0, peakAt: 0, rms: 0, dbfs: -Infinity, dc: 0, clipped: 0, clippedRatio: 0, crest: 0 }
  }
  let peak = 0
  let peakAt = 0
  let sum = 0
  let sumSquares = 0
  let clipped = 0
  for (let index = 0; index < frames; index += 1) {
    const value = samples[index]
    const magnitude = value < 0 ? -value : value
    if (magnitude > peak) {
      peak = magnitude
      peakAt = index
    }
    // A sample at or beyond full scale is the server's own hard clip, and it is
    // counted as such because the audible result is distortion, not loudness.
    if (magnitude >= 0.999) clipped += 1
    sum += value
    sumSquares += value * value
  }
  const rms = Math.sqrt(sumSquares / frames)
  return {
    frames,
    peak,
    peakAt,
    rms,
    dbfs: rms === 0 ? -Infinity : 20 * Math.log10(rms),
    dc: sum / frames,
    clipped,
    clippedRatio: clipped / frames,
    crest: rms === 0 ? 0 : peak / rms,
  }
}

/**
 * Spectral flatness of one channel: the geometric mean over the arithmetic mean
 * of the power spectrum.
 *
 * This is the tonality test. A pure tone concentrates all its energy in one bin
 * and scores near 0. White noise spreads it evenly and scores near 1. A gong
 * sits low — it has a handful of strong modes over a quiet floor — while a
 * clipped or noise-driven model scores high enough to say so.
 *
 * @param samples - one channel.
 * @param options - `{ sampleRate, fftSize }`.
 * @returns `{ flatness, verdict, fftSize, bins, centroidHz, rolloffHz }`.
 */
export function spectrum(samples, options = {}) {
  const sampleRate = options.sampleRate ?? 48_000
  const fftSize = options.fftSize ?? 8_192
  const frames = samples.length
  const size = Math.min(fftSize, frames)
  if (size < 64) {
    return { flatness: null, verdict: 'too short to analyse', fftSize: size, bins: 0, centroidHz: null, rolloffHz: null, peaks: [] }
  }
  // The loudest window in the signal, not the first one: a percussion strike
  // starts with silence and the interesting spectrum is at the hit.
  const hop = Math.max(1, Math.floor(size / 2))
  let bestStart = 0
  let bestEnergy = -1
  for (let start = 0; start + size <= frames; start += hop) {
    let energy = 0
    for (let index = start; index < start + size; index += 1) energy += samples[index] * samples[index]
    if (energy > bestEnergy) {
      bestEnergy = energy
      bestStart = start
    }
  }
  const win = hann(size)
  const real = new Float64Array(size)
  const imaginary = new Float64Array(size)
  for (let index = 0; index < size; index += 1) {
    real[index] = samples[bestStart + index] * win[index]
    imaginary[index] = 0
  }
  fft(real, imaginary)
  const bins = Math.floor(size / 2)
  const power = new Float64Array(bins)
  for (let bin = 0; bin < bins; bin += 1) {
    power[bin] = real[bin] * real[bin] + imaginary[bin] * imaginary[bin]
  }
  // Flatness is computed above a floor: digital silence in the top bins would
  // otherwise drag the geometric mean to zero and call everything a pure tone.
  let maximum = 0
  for (let bin = 0; bin < bins; bin += 1) if (power[bin] > maximum) maximum = power[bin]
  const floor = maximum * 1e-10
  let logSum = 0
  let sum = 0
  let counted = 0
  let weighted = 0
  let total = 0
  for (let bin = 0; bin < bins; bin += 1) {
    const value = Math.max(power[bin], floor)
    logSum += Math.log(value)
    sum += value
    counted += 1
    const hertz = (bin * sampleRate) / size
    weighted += hertz * power[bin]
    total += power[bin]
  }
  const arithmetic = sum / counted
  const geometric = Math.exp(logSum / counted)
  const flatness = arithmetic === 0 ? null : geometric / arithmetic
  const centroidHz = total === 0 ? null : weighted / total
  // Rolloff: the frequency below which 85 % of the energy sits.
  let running = 0
  let rolloffHz = null
  for (let bin = 0; bin < bins; bin += 1) {
    running += power[bin]
    if (rolloffHz === null && running >= total * 0.85) rolloffHz = (bin * sampleRate) / size
  }
  return {
    flatness,
    verdict: verdictFor(flatness),
    flatnessDb: flatness === null || flatness <= 0 ? null : 10 * Math.log10(flatness),
    fftSize: size,
    bins,
    centroidHz,
    rolloffHz,
    peaks: dominantPeaks(power, sampleRate, size, 6),
  }
}

/** The plain-language reading of a flatness value. */
export function verdictFor(flatness) {
  if (flatness === null) return 'unknown'
  if (flatness < 0.001) return 'strongly tonal (a clear pitch or a few modes)'
  if (flatness < 0.01) return 'tonal (modes over a quiet floor)'
  if (flatness < 0.1) return 'partly tonal (broadband attack over modes)'
  if (flatness < 0.4) return 'broadband (noise-like or heavily distorted)'
  return 'noise (no discernible pitch)'
}

/**
 * The strongest spectral peaks, as `{ hz, relative, db }`.
 *
 * Peaks are picked with a local-maximum test and then non-maximum-suppressed by
 * a few bins, so a single wide resonance is not reported as five separate
 * partials. This is what lets a modal model be checked against the frequencies
 * it was designed to ring at.
 *
 * Only peaks within `floorDb` of the loudest are reported. Without that floor the
 * FFT's own numerical noise in the empty top bins shows up as peaks — measured:
 * a synthetic gong reported "23906.3 Hz" beside its 64.5 Hz fundamental, which is
 * not a partial, it is rounding.
 *
 * @param power - the power spectrum.
 * @param sampleRate - the sample rate.
 * @param size - the DFT size.
 * @param count - how many peaks to return.
 * @param floorDb - how far below the loudest peak a candidate may be, in dB.
 * @returns the peaks, loudest first.
 */
export function dominantPeaks(power, sampleRate, size, count = 6, floorDb = 55) {
  const bins = power.length
  let maximum = 0
  for (let bin = 0; bin < bins; bin += 1) if (power[bin] > maximum) maximum = power[bin]
  if (maximum <= 0) return []
  const threshold = maximum * 10 ** (-floorDb / 10)
  const candidates = []
  for (let bin = 1; bin < bins - 1; bin += 1) {
    if (power[bin] < threshold) continue
    if (power[bin] > power[bin - 1] && power[bin] >= power[bin + 1]) {
      candidates.push({ bin, value: power[bin] })
    }
  }
  candidates.sort((a, b) => b.value - a.value)
  const chosen = []
  for (const candidate of candidates) {
    if (chosen.length >= count) break
    if (chosen.some((other) => Math.abs(other.bin - candidate.bin) <= 4)) continue
    chosen.push(candidate)
  }
  const loudest = chosen.length === 0 ? 1 : chosen[0].value
  return chosen
    .sort((a, b) => a.bin - b.bin)
    .map((candidate) => ({
      hz: Math.round(((candidate.bin * sampleRate) / size) * 10) / 10,
      relative: Math.round((candidate.value / loudest) * 1000) / 1000,
      db: Math.round(10 * Math.log10(candidate.value / loudest) * 10) / 10,
    }))
}

/**
 * An in-place iterative radix-2 Cooley–Tukey FFT.
 *
 * Iterative rather than recursive because the sizes here are 8 k and up, and a
 * recursive implementation at that size is a stack of thirteen frames per call
 * for no benefit. `size` must be a power of two.
 *
 * @param real - the real part, modified in place.
 * @param imaginary - the imaginary part, modified in place.
 */
export function fft(real, imaginary) {
  const size = real.length
  // Bit-reversal permutation.
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1
    for (; reversed & bit; bit >>= 1) reversed ^= bit
    reversed ^= bit
    if (index < reversed) {
      const temporary = real[index]
      real[index] = real[reversed]
      real[reversed] = temporary
      const other = imaginary[index]
      imaginary[index] = imaginary[reversed]
      imaginary[reversed] = other
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length
    const stepReal = Math.cos(angle)
    const stepImaginary = Math.sin(angle)
    for (let start = 0; start < size; start += length) {
      let currentReal = 1
      let currentImaginary = 0
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset
        const odd = even + length / 2
        const oddReal = real[odd] * currentReal - imaginary[odd] * currentImaginary
        const oddImaginary = real[odd] * currentImaginary + imaginary[odd] * currentReal
        real[odd] = real[even] - oddReal
        imaginary[odd] = imaginary[even] - oddImaginary
        real[even] += oddReal
        imaginary[even] += oddImaginary
        const nextReal = currentReal * stepReal - currentImaginary * stepImaginary
        currentImaginary = currentReal * stepImaginary + currentImaginary * stepReal
        currentReal = nextReal
      }
    }
  }
}

/**
 * A verdict on a whole capture, as one object.
 *
 * @param values - the interleaved floats from `/b_setn`.
 * @param options - `{ channels, sampleRate }`.
 * @returns `{ channels, sampleRate, frames, seconds, perChannel, worst, quiet, clipping, tone }`.
 */
export function analyse(values, options = {}) {
  const channels = Math.max(1, Math.floor(options.channels ?? 1))
  const sampleRate = options.sampleRate ?? 48_000
  const split = deinterleave(values, channels)
  const perChannel = split.map((samples, index) => {
    const level = amplitude(samples)
    const spectral = spectrum(samples, { sampleRate })
    return { channel: index, ...level, ...spectral }
  })
  const worst = perChannel.reduce((best, entry) => (entry.peak > best.peak ? entry : best), perChannel[0])
  const loudest = perChannel.reduce((best, entry) => (entry.rms > best.rms ? entry : best), perChannel[0])
  return {
    channels,
    sampleRate,
    frames: split[0].length,
    seconds: sampleRate === 0 ? 0 : split[0].length / sampleRate,
    perChannel,
    worst,
    clipping: worst.clipped > 0,
    quiet: loudest.rms < 0.0005,
    tone: worst.verdict,
  }
}
