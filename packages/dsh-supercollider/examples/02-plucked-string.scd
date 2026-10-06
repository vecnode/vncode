// 02-plucked-string.scd -- a waveguide string, plucked
//
// The technique: a burst of noise is fed into a delay line whose feedback is
// filtered. The filter makes high frequencies decay faster than low ones, which
// is exactly what a real string does, and the delay length is the pitch.
// `Pluck` is that waveguide in one UGen.
//
// Play:
//   ~pluck.value(220)         // A3
//   ~pluck.value(440, 0.2)    // A4, quieter
(
SynthDef(\exPluck, { |out = 0, freq = 220, amp = 0.4, decay = 6, coef = 0.4, pan = 0|
	var exc, sig, env;
	// The pluck: a short burst of noise. `coef` is the string's damping - a
	// higher value is a duller, shorter note.
	exc = WhiteNoise.ar(1) * EnvGen.kr(Env.perc(0.0005, 0.02));
	sig = Pluck.ar(exc, Impulse.ar(0), 0.05, freq.reciprocal, decay, coef);
	// A little body: the string alone is thin, so a gentle low shelf stays.
	sig = sig + LPF.ar(sig, 400);
	env = EnvGen.kr(Env([0, 1, 1, 0], [0.001, decay * 0.8, decay * 0.4], [\lin, \lin, -4]), doneAction: 2);
	Out.ar(out, Pan2.ar(LeakDC.ar(sig * env * amp), pan));
}).add;
~pluck = { |hz = 220, level = 0.4, damp = 0.4| Synth(\exPluck, [\freq, hz, \amp, level, \coef, damp]) };
)
// ~pluck.value(220);
