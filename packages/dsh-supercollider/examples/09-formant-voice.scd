// 09-formant-voice.scd -- a vowel: one source, three resonances
//
// The technique: the vocal folds are a buzzy source - here a sawtooth at `freq`
// - and the mouth is a filter. Three band-pass filters stand at the vowel's
// formants, the resonant peaks of the vocal tract, and the source has to pass
// through them to be heard as speech. A vowel IS the position of those three
// peaks and nothing else, which is why moving them changes "ah" into "ee" while
// the pitch stays exactly where it was.
//
// `vowel` runs 0 to 4 - ah, ee, oo, eh, er - and the sets are interpolated
// rather than switched, so 1.5 is halfway between "ee" and "oo". That is a
// vowel nobody speaks, which is what a crossfade between two vowels sounds
// like.
//
// One gotcha: LinSelectX crossfades between its inputs, so it will not accept
// plain numbers there - the formant arrays go through K2A, which turns each
// number into an audio-rate constant. Without it sclang refuses the def with
// "Select input was not audio rate". Ah and oo are close in the first formant
// and far apart in the second, so sweeping 0 to 2 and back is the cheapest way
// to hear what a formant does.
//
// Play:
//   ~formant.value(110, 0.3, 0)     // "ah" at 110 Hz
//   ~v = ~formant.value(110, 0.3, 2);   // "oo"; then ~v.set(\vowel, 0.4)
(
SynthDef(\exFormant, { |out = 0, freq = 110, amp = 0.3, vowel = 0, gate = 1, rq = 0.15, pan = 0|
	var src, env, f1, f2, f3, band1, band2, band3, sig;
	// The source: a band-limited saw, so it has every harmonic a glottal pulse
	// has and no aliasing to confuse the formants.
	src = Saw.ar(freq);
	env = EnvGen.kr(Env.asr(0.05, 1, 0.4), gate, doneAction: 2);
	// F1, F2, F3 per vowel: ah, ee, oo, eh, er. `vowel` interpolates between
	// neighbours, so a fractional vowel is a real in-between shape. K2A is what
	// makes the literals acceptable to LinSelectX, whose inputs must be signals.
	f1 = LinSelectX.ar(vowel, K2A.ar(#[730, 270, 300, 530, 640]));
	f2 = LinSelectX.ar(vowel, K2A.ar(#[1090, 2290, 870, 1840, 1190]));
	f3 = LinSelectX.ar(vowel, K2A.ar(#[2440, 3010, 2240, 2480, 2390]));
	// Three resonators in parallel, the classic parallel formant synthesiser.
	// The upper formants are quieter in a real voice, hence the weights.
	band1 = BPF.ar(src, f1, rq);
	band2 = BPF.ar(src, f2, rq) * 0.6;
	band3 = BPF.ar(src, f3, rq) * 0.35;
	// A narrow band of a saw is quiet; the makeup gain is what the filters cost.
	sig = LeakDC.ar((band1 + band2 + band3) * 6);
	Out.ar(out, Pan2.ar(sig * env * amp, pan));
}).add;
~formant = { |hz = 110, level = 0.3, which = 0| Synth(\exFormant, [\freq, hz, \amp, level, \vowel, which]) };
)
// ~formant.value(110, 0.3, 0);
