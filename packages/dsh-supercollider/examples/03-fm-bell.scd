// 03-fm-bell.scd -- an FM bell: the falling index is the strike
//
// The technique: one sine (the modulator) is added to the frequency of another
// (the carrier). How far it pushes is the INDEX, and the index decides how many
// sidebands appear around the carrier: a high index is a bright, clangy attack,
// an index of 0 is a bare sine. So an index envelope that falls from 6 to 0 is
// the whole bell - the strike is the entire spectrum and the tail is one quiet
// partial.
//
// The ratio is 3.5 on purpose. A ratio of 3 would put every sideband back on
// the harmonic series and you would hear a horn or an organ; a non-integer
// ratio leaves the partials where no common multiple lines them up, which is
// what the ear calls metal. Try `ratio` 2.7 or 4.13 as well.
//
// Play:
//   ~fmBell.value(440)          // A4 bell, 6 s tail
//   ~fmBell.value(220, 0.25)    // a lower, quieter bell
(
SynthDef(\exFMBell, { |out = 0, freq = 440, amp = 0.65, index = 6, decay = 6, ratio = 3.5, pan = 0|
	var modFreq, bend, mod, car, env, sig;
	modFreq = freq * ratio;
	// Full brightness at the strike, down to 12% in 12 ms, then a slow glide to
	// nothing over the rest of the tail. This contour is the sound.
	bend = EnvGen.kr(Env([index, index * 0.12, 0], [0.012, decay * 0.55], [-4, -5]));
	// Deviation = modulator frequency * index, so `index` is the textbook
	// modulation index and the brightness is in one number.
	mod = SinOsc.ar(modFreq) * modFreq * bend;
	car = SinOsc.ar(freq + mod);
	env = EnvGen.kr(Env.perc(0.002, decay, 1, -6), doneAction: 2);
	sig = car * env * amp;
	Out.ar(out, Pan2.ar(LeakDC.ar(sig), pan));
}).add;
~fmBell = { |hz = 440, level = 0.65| Synth(\exFMBell, [\freq, hz, \amp, level]) };
)
// ~fmBell.value(440);
