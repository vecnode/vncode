// 05-drum-kick.scd -- a kick: a pitch sweep, and a click on top of it
//
// The technique: two things happen in the first 40 ms. A sine starts four times
// too high and falls to its target pitch, and that fast downward sweep is the
// beater hitting the skin - it is what the ear hears as "thump" and not as a
// bass note. A very short burst of high-passed noise sits on top of it for the
// beater itself. After that there is only an amplitude envelope, and it is the
// decay time that decides whether this is a techno kick or a heartbeat.
//
// The sweep is exponential (Env curve \exp) for a reason: a linear sweep sounds
// like a synth falling over, an exponential one sounds like a drum.
//
// Play:
//   ~kick.value(48)             // 48 Hz, ~0.5 s
//   ~kick.value(38, 0.9, 1.2)   // lower and longer
(
SynthDef(\exKick, { |out = 0, freq = 48, amp = 0.9, pitchAmount = 4, decay = 0.5, click = 0.15, pan = 0|
	var pitch, body, thump, beater, sig;
	// The contour: pitchAmount x freq down to freq in 45 ms.
	pitch = EnvGen.kr(Env([pitchAmount, 1], [0.045], \exp));
	body = SinOsc.ar(freq * pitch);
	// `doneAction: 2` is on the THUMP's envelope, not the beater's: the thump is
	// the longest part of the sound, so it is the one that decides when the node is
	// finished. An envelope without it leaves the node alive for ever at zero
	// amplitude — a leak that is invisible until the server is full of them.
	thump = body * EnvGen.kr(Env.perc(0.002, decay, 1, -4), doneAction: 2);
	// The beater: 12 ms of noise, high-passed so it ticks instead of thudding.
	beater = HPF.ar(WhiteNoise.ar(1), 1500) * EnvGen.kr(Env.perc(0.0002, 0.012, 1, -8));
	sig = (thump * 0.72) + (beater * click * 0.25);
	// 0.72 + 0.25 keeps even click = 1 under the ceiling.
	Out.ar(out, Pan2.ar(LeakDC.ar(sig * amp), pan));
}).add;
~kick = { |hz = 48, level = 0.9, len = 0.5| Synth(\exKick, [\freq, hz, \amp, level, \decay, len]) };
)
// ~kick.value(48);
