// 10-glass-choir.scd -- struck glass: an additive bank of inharmonic partials
//
// The technique: a single bank of `SinOsc`s, one per partial, summed directly.
// The RATIOS are what make it glass instead of organ: a struck bar rings at
// roughly 1, 2.76, 5.40, 8.93, 13.34, which are stretched, not the 1, 2, 3, 4
// of a tube of air. Giving every partial its OWN decay makes it struck rather
// than blown - the high partials vanish first and leave the low ring behind.
//
// Try `spread` around 2 for a wide, shivering halo; 0 is a dry, close glass.
//
// Play:
//   ~glass.value(440)          // mid range, 5 second ring
//   ~glass.value(880, 0.25, 9) // higher, longer, a little quieter
(
SynthDef(\exGlass, { |out = 0, freq = 440, amp = 0.3, decay = 5, spread = 1, pan = 0|
	var ratios, weights, partials, layers, sumW, sig, env;
	// Stretched ratios of a struck bar, not consecutive harmonics.
	ratios = #[1, 2.76, 5.4, 8.93, 13.34];
	// A natural rolloff, normalised so the bank cannot sum past full scale.
	weights = ratios.collect { |r| r ** -0.7 };
	sumW = weights.sum;
	partials = ratios.collect { |r, i|
		var partialDecay, driftF, sigL, sigR;
		partialDecay = decay * (0.75 + (1.9 / (i + 1)));
		// The two sides drift apart, so every partial beats against itself.
		driftF = 1 + (LFNoise2.kr(0.07 + (i * 0.03), spread * 0.0015).midicps - 1);
		sigL = SinOsc.ar(freq * (r - (r * 0.0015 * spread))) * (weights[i] / sumW);
		sigL = sigL * EnvGen.kr(Env.perc(0.004, partialDecay, 1, -5));
		sigR = SinOsc.ar(freq * (r + (r * 0.0015 * spread)) * driftF) * (weights[i] / sumW);
		sigR = sigR * EnvGen.kr(Env.perc(0.006, partialDecay * 1.03, 1, -5));
		[sigL, sigR];
	};
	layers = partials.flop;
	sig = [(layers[0].sum), (layers[1].sum)];
	// One body envelope over the whole bank, so the strike is a single event.
	env = EnvGen.kr(Env([0, 1, 1, 0], [0.004, decay, decay * 0.7], [\lin, \lin, -4]), doneAction: 2);
	Out.ar(out, Pan2.ar(LeakDC.ar(sig * env * amp), pan));
}).add;
~glass = { |hz = 440, level = 0.3, ring = 5, halo = 1|
	Synth(\exGlass, [\freq, hz, \amp, level, \decay, ring, \spread, halo]);
};
)
// ~glass.value(440);
