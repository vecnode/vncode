// 07-drum-hat.scd -- a hi-hat: six inharmonic squares, high-passed hard
//
// The technique: metal is not noise. A hat is six square waves at deliberately
// inharmonic frequencies (301, 353, 421, 487, 611, 887 Hz - no two of them
// share a common multiple), summed and then high-passed. The squares are what
// give the dense, ringy spectrum; the high-pass at 7 kHz is what throws away
// the body and leaves the "tss". Drop `hp` to 3 kHz and it becomes a clang.
//
// The high-pass costs nearly all of the level - what is left above 7 kHz is the
// 25th and higher harmonics of each square - so the sum is scaled up rather
// than down before the filter. The cutoff also falls as the sound decays, so
// the first millisecond is the brightest thing in the file. `open = 1`
// stretches the decay into an open hat without touching anything else.
//
// Play:
//   ~hat.value(0)               // closed, 60 ms
//   ~hat.value(1, 0.4)          // open hat, ~0.6 s
(
SynthDef(\exHat, { |out = 0, amp = 0.5, decay = 0.06, open = 0, hp = 7000, pan = 0|
	var metal, sum, cut, env, sig;
	metal = #[301, 353, 421, 487, 611, 887];
	// Pulse width 0.5 is a square wave, and Pulse is band-limited, so the six of
	// them can sit this low without aliasing.
	sum = metal.collect { |f| Pulse.ar(f, 0.5) }.sum * 2;
	// Descending cutoff: brightest at the strike, back down to `hp` in 20 ms.
	cut = EnvGen.kr(Env([hp * 1.6, hp], [0.02 + (open * 0.3)], -4));
	sig = HPF.ar(sum, cut);
	env = EnvGen.kr(Env.perc(0.0005, decay + (open * 0.55), 1, -8), doneAction: 2);
	Out.ar(out, Pan2.ar(LeakDC.ar(sig * env * amp), pan));
}).add;
~hat = { |openness = 0, level = 0.5| Synth(\exHat, [\open, openness, \amp, level]) };
)
// ~hat.value(0);
