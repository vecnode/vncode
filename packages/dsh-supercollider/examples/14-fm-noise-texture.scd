// 14-fm-noise-texture.scd -- wind and water: noise through a moving filter
//
// The technique: filtered noise plus a moving filter is the basis of most
// environmental sound. There is no pitch here at all - the ear reads the
// filter's centre frequency, its Q and how fast both move, and nothing else.
//
// `rq` is the reciprocal of Q: a small `rq` is a narrow, whistling resonance
// (wind), a large one is a wide, breathing band (water). `motion` scales how
// far the slow LFO travels from `cutoff`.
//
// Play:
//   ~texture.value()             // a wide, watery band
//   ~texture.value(1600, 0.15)   // narrow and high: wind through a gap
(
SynthDef(\exTexture, { |out = 0, amp = 0.25, cutoff = 800, rq = 0.4, gate = 1, motion = 1|
	var src, lfo, band, breath, env, sig;
	// Pink noise: equal energy per octave, which is what most natural noise is.
	src = PinkNoise.ar(1) + (BrownNoise.ar(0.5));
	// A slow random walk, not a sine: wind does not move periodically.
	lfo = LFNoise1.kr(0.2) * motion;
	band = RLPF.ar(src, (cutoff * (2 ** (lfo * 1.2))).clip(60, 12000), rq.clip(0.05, 1));
	// Amplitude breathes on its own, at its own rate, so the two never lock.
	breath = (LFNoise1.kr(0.09).range(0.35, 1) * (1 + (motion * 0.25))).clip(0.1, 1.4);
	// A little high-passed noise stays outside the band, keeping it airy.
	sig = (band * 1.6) + (HPF.ar(src, 4000) * 0.05);
	env = EnvGen.kr(Env.asr(0.9, 1, 2.2, \lin), gate, doneAction: 2);
	Out.ar(out, Pan2.ar(LeakDC.ar(sig * breath * env * amp * 0.9), LFNoise1.kr(0.05).range(-0.6, 0.6)));
}).add;
~texture = { |hz = 800, q = 0.4, level = 0.25, move = 1|
	Synth(\exTexture, [\cutoff, hz, \rq, q, \amp, level, \motion, move, \gate, 1]);
};
)
// ~texture.value();
