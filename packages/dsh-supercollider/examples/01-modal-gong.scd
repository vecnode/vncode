// 01-modal-gong.scd -- struck metal: a bank of inharmonic modes
//
// The technique: a single-sample impulse carries equal energy into every mode of
// a resonator bank, so the BANK decides the pitch and the IMPULSE decides the
// strike. A gong's modes are not harmonic - the near-miss pairs beat, and that
// beating is what the ear hears as metal.
//
// See also: `Modal Space.scd` in the SuperCollider examples/demonstrations shown
// under "References" in this folder's README. This file is original; it is an
// implementation of the technique, not a copy.
//
// The one thing worth knowing before you edit it: in a `Klank`, a mode's level
// depends on its RING TIME as much as on its amplitude, because a constant-skirt
// resonator accumulates over its decay. Long decays are much louder than short
// ones at the same amplitude setting. Get that balance wrong and the bank turns
// into a bright hiss with no audible root - which is the single most common way a
// modal model stops sounding like metal. This file compensates for it in `amps`,
// and the comment there records the measurement.
//
// Play:
//   ~gong.value(62)           // deep tam-tam, 62 Hz
//   ~gong.value(110)          // small, bright gong
// Measure it with sc_capture before you describe it; `peak` should land near 0.25
// and the partials should show a low mode among them, not only high ones.
(
SynthDef(\exModalGong, { |out = 0, pitch = 62, amp = 0.8, decayScale = 1, strike = 1, grime = 0.25|
	var modes, rings, amps, sp, freqsL, freqsR, click, exc, bend, sigL, sigR, env;
	// Inharmonic mode ratios. 1.46/1.48 and 2.13/2.16 are deliberately close.
	modes = #[1, 1.46, 1.48, 2.13, 2.16, 2.55, 2.84, 3.33, 3.67, 4.03, 4.61, 5.03];
	// Higher modes radiate faster, so their 60 dB ring times are much shorter. The
	// BASE has to be long: 50 s at the root is a gong, and a few seconds is a thud.
	// This one number governs the fundamental's decay AND, because of the next
	// paragraph, how loud the fundamental is.
	rings = modes.collect { |m| (50 / (m ** 1.15)).clip(0.35, 60) } * decayScale;
	// Level per mode. This is the part that is easy to get wrong, and the ear
	// notices immediately when you do: a mode's level in a `Klank` is set by its
	// RING TIME as well as its amplitude, because a constant-skirt resonator
	// accumulates over its decay. Left uncompensated, the short high modes win and
	// the bank measures as a bright hiss with no audible root.
	//
	// Measured on this bank, with everything else fixed: two modes at equal
	// amplitude, one ringing 20 s and one 0.5 s, come out 6.8x apart in level -
	// that is +16 dB for 40x the ring time, so the accumulation is close to the
	// SQUARE ROOT of the ring time rather than proportional to it. Compensating by
	// `m ** 0.35` on top of that is what leaves the low modes carrying the sound.
	amps = modes.collect { |m| (1.30 / (m ** 0.55)) / ((50 / (m ** 1.15)).clip(0.35, 60).sqrt / 4) };
	// Two banks skewed slightly apart, so the beats never settle.
	sp = 0.004;
	freqsL = modes - (modes * sp);
	freqsR = modes + (modes * sp);
	click = Impulse.ar(0, 0, 1);
	// A single-sample impulse carries equal energy into every mode, so the strike
	// level is small and the RESONATORS supply the loudness. This number is set by
	// measuring the result, not by taste: `sc_capture` reports the peak, and the
	// aim is about 0.3 at the default `amp`.
	exc = (click + (HPF.ar(ClipNoise.ar(1), 1800) * grime * 0.6)) * strike * 0.12;
	bend = Line.kr(1.028, 1, 1.6);          // a real gong bends sharp, then settles
	sigL = Klank.ar(`[freqsL, amps, rings], exc * bend);
	sigR = Klank.ar(`[freqsR, amps, rings], exc * bend);
	env = EnvGen.kr(Env([0, 1, 1, 0], [0.002, 40, 6], [\lin, \lin, -4]), doneAction: 2);
	Out.ar(out, Balance2.ar(LeakDC.ar(sigL * env * amp), LeakDC.ar(sigR * env * amp), 0));
}).add;
~gong = { |hz = 62, level = 1| Synth(\exModalGong, [\pitch, hz, \amp, level]) };
)// ~gong.value(62);
