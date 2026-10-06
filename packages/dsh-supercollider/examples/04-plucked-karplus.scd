// 04-plucked-karplus.scd -- a Karplus-Strong string on a plain comb
//
// The technique: a short burst of noise goes into a delay line with feedback (a
// comb). The delay time is the pitch - delay 1/freq seconds and the burst
// repeats freq times a second - and the comb's decay time is how long the
// echoes take to fall 60 dB, which is how long the string rings. Shorten the
// burst and it is a pluck; leave it on and it becomes a bowed drone.
//
// The low-pass is the string's damping: a bare comb is a buzz, because every
// partial dies at the same rate, so the filter sits across the output and takes
// the top away. `bright` is that cutoff - 2500 is nylon, 800 is a muted
// thumb, 6000 is a harpsichord.
//
// Play:
//   ~karplus.value(330)          // E4, ringing for 4 s
//   ~karplus.value(110, 0.35, 8) // low and long
(
SynthDef(\exKarplus, { |out = 0, freq = 330, amp = 0.4, decay = 4, bright = 2500, pan = 0|
	var burst, exc, string, sig, env;
	// The pluck: 20 ms of noise, already darkened by the string's damping.
	burst = LPF.ar(WhiteNoise.ar(1), bright);
	// A comb gives back only a fraction of what is fed into it (its copies
	// overlap and partly cancel), so the burst is scaled up here to bring the
	// pluck to full level. The loop's own decay is unaffected: `decay` is the
	// feedback inside CombL, not the level of the signal that enters it.
	exc = burst * EnvGen.kr(Env.perc(0.0005, 0.02, 1, -4)) * 3;
	// Delay = the pitch, decay = the ring time, 0.1 s max = a 10 Hz floor.
	string = CombL.ar(exc, 0.1, freq.reciprocal, decay);
	sig = LPF.ar(string, bright);
	// CombL's feedback holds DC, so the tail is leaked rather than left to drift.
	env = EnvGen.kr(Env([0, 1, 1, 0], [0.001, decay * 0.7, decay * 0.5], [\lin, \lin, -4]), doneAction: 2);
	Out.ar(out, Pan2.ar(LeakDC.ar(sig * env * amp), pan));
}).add;
~karplus = { |hz = 330, level = 0.4, ring = 4| Synth(\exKarplus, [\freq, hz, \amp, level, \decay, ring]) };
)
// ~karplus.value(330);
