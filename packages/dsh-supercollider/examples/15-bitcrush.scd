// 15-bitcrush.scd -- amplitude quantisation plus sample-rate reduction
//
// The technique: two separate artefacts, often confused. BITCRUSH is amplitude
// quantisation - `.round(step)` snaps every sample to a grid, and the error the
// snapping leaves behind is the harsh, granular buzz. DOWNSAMPLE is holding a
// value: `Latch` samples the source once per `Impulse` and keeps that value, so
// a low `downsample` rate samples the waveform at a low sample rate.
//
// Bitcrush adds hiss and grit to quiet passages; downsampling adds aliasing
// tones that track the pitch. Try them separately to hear the difference.
//
// Play:
//   ~crush.value(220, 4, 8)     // coarse quantisation, moderate hold
//   ~crush.value(220, 2, 40)    // almost square, and ringing with aliases
(
SynthDef(\exCrush, { |out = 0, freq = 220, amp = 0.3, bits = 4, downsample = 8, gate = 1|
	var steps, src, quant, rate, held, env, sig;
	// `bits` 4 means 2 ** (4 - 1) = 8 levels per side. The floor on `bits` keeps
	// the divisor away from zero at absurd settings.
	steps = 2 ** (bits.clip(1, 12) - 1);
	src = (SinOsc.ar(freq) + (SinOsc.ar(freq * 2.01) * 0.3)) * 0.7;
	// Amplitude quantisation: snap to the nearest of `steps` levels per side.
	quant = (src * steps).round(1) / steps;
	// Sample-rate reduction: keep one sample per `downsample` original samples.
	rate = SampleRate.ir / downsample.clip(1, 256);
	held = Latch.ar(quant, Impulse.ar(rate, 0.5));
	env = EnvGen.kr(Env.asr(0.01, 1, 0.12, \lin), gate, doneAction: 2);
	sig = held * env * amp;
	Out.ar(out, Pan2.ar(LeakDC.ar(sig), 0));
}).add;
~crush = { |hz = 220, b = 4, ds = 8, level = 0.3|
	Synth(\exCrush, [\freq, hz, \bits, b, \downsample, ds, \amp, level, \gate, 1]);
};
)
// ~crush.value(220, 4, 8);
