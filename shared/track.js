// Deterministic procedurally generated track.
// Imported by both the Node server and the browser so every client sees
// exactly the same terrain for a given seed.

export const TRACK_STEP = 0.25;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * Build a track from a numeric seed.
 * @param {number} seed
 * @param {number} length distance in metres from start to finish line
 */
export function createTrack(seed, length = 900) {
  const rng = mulberry32(seed);
  const step = TRACK_STEP;
  const runout = 90;
  const total = length + runout;
  const count = Math.ceil(total / step) + 2;
  const heights = new Float32Array(count);

  const waves = [];
  const waveCount = 7;
  for (let i = 0; i < waveCount; i++) {
    const len = 34 + rng() * 120;
    const maxSlope = 0.08 + rng() * 0.26;
    const amp = (maxSlope * len) / (2 * Math.PI);
    waves.push({ amp, len, phase: rng() * Math.PI * 2 });
  }

  const base = 70;
  const raw = (x) => {
    let h = base;
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i];
      h += w.amp * Math.sin((2 * Math.PI * x) / w.len + w.phase);
    }
    return h;
  };

  const padLen = 34;
  const padHeight = raw(0);
  const finishLen = 45;
  const finishHeight = raw(length - finishLen);

  for (let i = 0; i < count; i++) {
    const x = i * step;
    let h = raw(x);

    if (x < padLen) {
      // completely flat launch pad, then ease into the hills
      h = padHeight;
    } else if (x < padLen + 24) {
      const t = smoothstep((x - padLen) / 24);
      h = padHeight * (1 - t) + h * t;
    }
    if (x > length - finishLen) {
      const t = smoothstep(Math.min(1, (x - (length - finishLen)) / finishLen));
      h = h * (1 - t) + finishHeight * t;
    }
    heights[i] = h;
  }

  // Guarantee drivable gradients: clamp the height change per sample so the
  // hills never exceed ~23 degrees, no matter how the waves combine.
  const maxRise = 0.42 * step;
  for (let i = 1; i < count; i++) {
    const prev = heights[i - 1];
    if (heights[i] > prev + maxRise) heights[i] = prev + maxRise;
    else if (heights[i] < prev - maxRise) heights[i] = prev - maxRise;
  }

  const track = {
    seed,
    length,
    step,
    heights,
    startX: 8,
    finishX: length,
    heightAt(x) {
      if (x <= 0) return heights[0];
      const idx = x / step;
      if (idx >= count - 1) return heights[count - 1];
      const i = Math.floor(idx);
      const f = idx - i;
      return heights[i] * (1 - f) + heights[i + 1] * f;
    },
    slopeAt(x) {
      return (track.heightAt(x + 0.5) - track.heightAt(x - 0.5)) / 1;
    },
    angleAt(x) {
      return Math.atan(track.slopeAt(x));
    },
  };

  return track;
}

export function randomSeed() {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}
