// Beat tracking for "Add beat markers": an onset envelope (spectral flux of decoded
// audio, or rises in the timeline waveform's peaks when decoding isn't possible), a tempo
// from its autocorrelation (with a soft preference for ~120 BPM to avoid octave
// mistakes), then dynamic-programming beat tracking (Ellis 2007), which follows the
// onsets while keeping the beats evenly spaced.

/** Analysis rate: plenty for rhythm, and cheap. */
export const BEAT_RATE = 11025;
const WIN = 512;
const HOP = 128;

export interface Beats {
  bpm: number;
  /** Seconds from the start of the samples. */
  times: number[];
}

/** In-place radix-2 FFT; `cos`/`sin` hold the n/2 twiddle factors. */
function fft(re: Float64Array, im: Float64Array, cos: Float64Array, sin: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** Onset strength per hop: positive change in log-magnitude spectrum, locally normalised. */
export function onsetEnvelope(samples: Float32Array): Float64Array {
  const frames = Math.max(0, Math.floor((samples.length - WIN) / HOP) + 1);
  const env = new Float64Array(frames);
  const hann = Float64Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN));
  const cos = Float64Array.from({ length: WIN / 2 }, (_, k) => Math.cos((-2 * Math.PI * k) / WIN));
  const sin = Float64Array.from({ length: WIN / 2 }, (_, k) => Math.sin((-2 * Math.PI * k) / WIN));
  let prev = new Float64Array(WIN / 2);
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < WIN; i++) {
      re[i] = samples[f * HOP + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im, cos, sin);
    const mag = new Float64Array(WIN / 2);
    let flux = 0;
    for (let k = 0; k < WIN / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      if (f > 0) flux += Math.max(0, mag[k] - prev[k]);
    }
    env[f] = flux;
    prev = mag;
  }
  // Remove the slowly varying level (≈0.4 s moving average) so loud passages don't dominate.
  const half = Math.round((0.2 * BEAT_RATE) / HOP);
  const out = new Float64Array(frames);
  let sum = 0;
  for (let i = 0; i < Math.min(frames, half); i++) sum += env[i];
  for (let i = 0; i < frames; i++) {
    if (i + half < frames) sum += env[i + half];
    if (i - half - 1 >= 0) sum -= env[i - half - 1];
    const n = Math.min(frames - 1, i + half) - Math.max(0, i - half) + 1;
    out[i] = Math.max(0, env[i] - sum / n);
  }
  const sd = Math.sqrt(out.reduce((s, v) => s + v * v, 0) / Math.max(1, frames)) || 1;
  for (let i = 0; i < frames; i++) out[i] /= sd;
  return out;
}

/** Beat period in frames (fractional), from the autocorrelation of the onset envelope. */
function period(env: Float64Array, fps: number): number {
  const lo = Math.floor((60 / 200) * fps);
  const hi = Math.ceil((60 / 60) * fps);
  const score = (lag: number) => {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    return s / (env.length - lag);
  };
  let best = 0;
  let bestLag = Math.round((60 / 120) * fps);
  const raw: number[] = [];
  for (let lag = lo; lag <= hi; lag++) {
    // Log-Gaussian preference around 120 BPM (as in librosa) to settle octave ambiguity.
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    raw[lag] = score(lag);
    const s = raw[lag] * prior;
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  // Parabolic refinement for a fractional period.
  const [a, b, c] = [raw[bestLag - 1], raw[bestLag], raw[bestLag + 1]];
  if (a != null && c != null && a - 2 * b + c < 0) return bestLag + (0.5 * (a - c)) / (a - 2 * b + c);
  return bestLag;
}

/** Beat times (seconds) of mono samples at BEAT_RATE. */
export function detectBeats(samples: Float32Array): Beats {
  // Frames are centred on their window.
  return trackBeats(onsetEnvelope(samples), BEAT_RATE / HOP, WIN / 2 / BEAT_RATE);
}

/** Beat times from waveform peaks (0..1, `rate` per second): onsets are rises in level. */
export function beatsFromPeaks(peaks: ArrayLike<number>, rate: number): Beats {
  const rise = new Float64Array(peaks.length);
  for (let i = 1; i < peaks.length; i++) rise[i] = Math.max(0, Math.log1p(100 * peaks[i]) - Math.log1p(100 * peaks[i - 1]));
  // Coarse buckets put onsets a bucket early or late; a small binomial blur keeps the
  // beat period from splitting across neighbouring lags.
  const env = new Float64Array(rise.length);
  const k = [1, 4, 6, 4, 1];
  for (let i = 0; i < rise.length; i++) {
    for (let j = -2; j <= 2; j++) env[i] += (rise[i + j] ?? 0) * k[j + 2];
    env[i] /= 16;
  }
  return trackBeats(env, rate, 0);
}

/** Tempo and beats of an onset envelope sampled `fps` times a second (frame i at i/fps + offset). */
export function trackBeats(env: Float64Array, fps: number, offset: number): Beats {
  if (env.length < fps * 2 || !env.some((v) => v > 0)) return { bpm: 0, times: [] };
  const p = period(env, fps);
  // Dynamic programming: each frame's best score is its onset plus the best earlier beat
  // about one period back, penalised by how far that gap strays from the period.
  const tight = 100;
  const score = new Float64Array(env.length);
  const back = new Int32Array(env.length).fill(-1);
  for (let t = 0; t < env.length; t++) {
    let best = 0;
    let from = -1;
    for (let tau = Math.max(0, t - Math.round(2 * p)); tau <= t - Math.round(p / 2); tau++) {
      const s = score[tau] - tight * Math.log((t - tau) / p) ** 2;
      if (from < 0 || s > best) {
        best = s;
        from = tau;
      }
    }
    score[t] = env[t] + (from >= 0 ? Math.max(0, best) : 0);
    back[t] = from >= 0 && best > 0 ? from : -1;
  }
  // Start from the strongest frame in the last period and walk back.
  let t = env.length - 1;
  for (let i = Math.max(0, env.length - Math.round(p)); i < env.length; i++) if (score[i] > score[t]) t = i;
  const frames: number[] = [];
  for (; t >= 0; t = back[t]) frames.push(t);
  frames.reverse();
  return { bpm: (60 * fps) / p, times: frames.map((f) => f / fps + offset) };
}

/** Box-filtered downsampling to BEAT_RATE (enough for onsets). */
export function toBeatRate(samples: Float32Array, rate: number): Float32Array {
  if (Math.abs(rate - BEAT_RATE) < 1) return samples;
  const r = rate / BEAT_RATE;
  const out = new Float32Array(Math.floor(samples.length / r));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * r);
    const b = Math.max(a + 1, Math.floor((i + 1) * r));
    let sum = 0;
    for (let j = a; j < b; j++) sum += samples[j];
    out[i] = sum / (b - a);
  }
  return out;
}

/** Mix channels down to mono. */
export function mono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}
