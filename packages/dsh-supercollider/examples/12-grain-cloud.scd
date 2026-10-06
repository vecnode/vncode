// 12-grain-cloud.scd -- a granular cloud over a live internal source
//
// The technique: granular synthesis is many very short windows over a source.
// Here the source is an oscillator inside the synth rather than a sample, and
// `Impulse.kr(rate)` triggers one window per grain. Each grain reads its own
// pitch, which the cloud jitters around `baseFreq`.
//
// `rate` and `grainDur` together decide what you hear: if the grains overlap
// you get a texture, if they are sparse and short you get clicks, and if the
// rate lines up with `baseFreq` the cloud locks into a tone.
//
// Play:
//   ~grains.value(20, 0.05)    // sparse, dry grains
//   ~grains.value(200, 0.12)   // dense and continuous
(
SynthDef(\exGrains, { |out = 0, amp = 0.3, rate = 20, grainDur = 0.05, baseFreq = 220, spread = 0.5, gate = 1|
	var trig, pitchMul, src, window, sig, env;
	// One trigger per grain.
	trig = Impulse.kr(rate);
	// A new random pitch interval per grain, held for the grain.
	pitchMul = (LFNoise0.kr(rate) * spread).midiratio;
	src = SinOsc.ar(baseFreq * pitchMul) + (PinkNoise.ar(0.25));
	// The window: a percussive envelope, one per grain, never ending the node.
	window = EnvGen.kr(Env.perc(0.001, grainDur, 1, -4), trig);
	sig = src * window * 0.5;
	// The voice's own gate, so the cloud can be held and released.
	env = EnvGen.kr(Env.asr(0.05, 1, 0.4, \lin), gate, doneAction: 2);
	Out.ar(out, Pan2.ar(LeakDC.ar(sig * env * amp), LFNoise1.kr(0.4).range(-0.8, 0.8)));
}).add;
~grains = { |grate = 20, dur = 0.05, hz = 220, level = 0.3|
	Synth(\exGrains, [\rate, grate, \grainDur, dur, \baseFreq, hz, \amp, level, \gate, 1]);
};
)
// ~grains.value(20, 0.05);
