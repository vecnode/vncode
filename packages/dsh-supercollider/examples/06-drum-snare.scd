// 06-drum-snare.scd -- a snare: one tuned drum, plus a band of noise
//
// The technique: a snare is two sounds at once. The head is a drum - two tuned
// sine modes (the fundamental and a shallow shell's first overtone, 180 and
// 330 Hz here) with a decay measured in tens of milliseconds - and the wires
// stretched under it are noise, band-passed around 3 kHz so that it reads as
// wires rather than as a hiss. Neither half is a snare.
//
// The BALANCE between the two is the character, which is what `toneLevel` and
// `noiseLevel` are for. The two layers are also tuned independently: 200 Hz
// with 4 kHz is a piccolo, 150 Hz with 2.2 kHz is a fat rock snare, and pushing
// `noiseLevel` alone gives you a drum machine clap.
//
// Play:
//   ~snare.value                     // the default crack
//   ~snare.value(150, 0.9, 0.09)     // lower and much shorter
(
SynthDef(\exSnare, { |out = 0, amp = 0.8, decay = 0.18, noiseLevel = 0.5, toneLevel = 0.5, freq = 180, snareHz = 3000, pan = 0|
	var head, headEnv, wires, wireEnv, sig;
	// Two modes. 1.83 is the shell's overtone, not a harmonic of it.
	head = SinOsc.ar(freq) + (SinOsc.ar(freq * 1.83) * 0.7);
	headEnv = EnvGen.kr(Env.perc(0.001, decay, 1, -6), doneAction: 2);
	// The wires: broadband noise squeezed into a band around snareHz.
	wires = BPF.ar(WhiteNoise.ar(1), snareHz, 0.6);
	wireEnv = EnvGen.kr(Env.perc(0.001, decay * 0.75, 1, -5));
	sig = ((head * headEnv * toneLevel * 0.5) + (wires * wireEnv * noiseLevel * 0.7));
	Out.ar(out, Pan2.ar(LeakDC.ar(sig * amp), pan));
}).add;
~snare = { |hz = 180, level = 0.8, len = 0.18, wire = 0.5| Synth(\exSnare, [\freq, hz, \amp, level, \decay, len, \noiseLevel, wire]) };
)
// ~snare.value(180);
