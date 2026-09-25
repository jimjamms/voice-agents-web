/* Local, opt-in speaker matching. No raw voice sample or voiceprint is sent to the Worker. */
(() => {
  const KEY = 'sage-astra-voiceprints-v1';
  const RATE = 16000, FFT = 1024, HOP = 256, MEL_BANDS = 40, COEFFICIENTS = 20;
  const hzToMel = hz => 2595 * Math.log10(1 + hz / 700);
  const melToHz = mel => 700 * (10 ** (mel / 2595) - 1);
  const melEdges = Array.from({ length: MEL_BANDS + 2 }, (_, i) =>
    Math.floor(melToHz(hzToMel(RATE / 2) * i / (MEL_BANDS + 1)) * FFT / RATE));
  const melFilters = Array.from({ length: MEL_BANDS }, (_, i) => {
    const weights = [];
    for (let bin = melEdges[i]; bin < melEdges[i + 2]; bin++) {
      const weight = bin <= melEdges[i + 1]
        ? (bin - melEdges[i]) / Math.max(1, melEdges[i + 1] - melEdges[i])
        : (melEdges[i + 2] - bin) / Math.max(1, melEdges[i + 2] - melEdges[i + 1]);
      if (bin >= 0 && bin <= FFT / 2 && weight > 0) weights.push([bin, weight]);
    }
    return weights;
  });
  const twiddles = Array.from({ length: 10 }, (_, stage) => {
    const len = 2 ** (stage + 1);
    return Array.from({ length: len / 2 }, (_, k) => [Math.cos(-2 * Math.PI * k / len), Math.sin(-2 * Math.PI * k / len)]);
  });
  const dct = Array.from({ length: COEFFICIENTS }, (_, coefficient) =>
    Float64Array.from({ length: MEL_BANDS }, (_, band) =>
      Math.cos(Math.PI * coefficient * (band + .5) / MEL_BANDS)));
  function spectrum(frame) {
    const real = Float64Array.from(frame), imag = new Float64Array(FFT);
    for (let i = 1, j = 0; i < FFT; i++) {
      let bit = FFT >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [real[i], real[j]] = [real[j], real[i]]; }
    }
    for (let len = 2, stage = 0; len <= FFT; len *= 2, stage++) {
      for (let start = 0; start < FFT; start += len) {
        for (let k = 0; k < len / 2; k++) {
          const [cos, sin] = twiddles[stage][k];
          const even = start + k, odd = even + len / 2;
          const r = real[odd] * cos - imag[odd] * sin;
          const im = real[odd] * sin + imag[odd] * cos;
          real[odd] = real[even] - r; imag[odd] = imag[even] - im;
          real[even] += r; imag[even] += im;
        }
      }
    }
    return Float64Array.from({ length: FFT / 2 + 1 }, (_, i) => real[i] ** 2 + imag[i] ** 2);
  }
  function extract(samples, sampleRate) {
    if (!samples || samples.length / sampleRate < .4) return null;
    const size = Math.floor(samples.length * RATE / sampleRate);
    const mono = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const position = i * sampleRate / RATE, index = Math.floor(position);
      mono[i] = samples[index] * (1 - (position - index)) +
        (samples[Math.min(index + 1, samples.length - 1)] || 0) * (position - index);
    }
    const sums = new Float64Array(COEFFICIENTS), squares = new Float64Array(COEFFICIENTS);
    let frames = 0;
    for (let offset = 0; offset + FFT <= size; offset += HOP) {
      const frame = new Float64Array(FFT);
      for (let i = 0; i < FFT; i++) frame[i] = mono[offset + i] * (.5 - .5 * Math.cos(2 * Math.PI * i / (FFT - 1)));
      const power = spectrum(frame);
      const logMels = melFilters.map(filter => Math.log(Math.max(1e-12,
        filter.reduce((sum, [bin, weight]) => sum + power[bin] * weight, 0))));
      for (let coefficient = 0; coefficient < COEFFICIENTS; coefficient++) {
        let value = 0;
        for (let band = 0; band < MEL_BANDS; band++)
          value += logMels[band] * dct[coefficient][band];
        sums[coefficient] += value; squares[coefficient] += value * value;
      }
      frames++;
    }
    if (!frames) return null;
    const vector = Array.from(sums, (sum, i) => sum / frames)
      .concat(Array.from(squares, (sum, i) => Math.sqrt(Math.max(0, sum / frames - (sums[i] / frames) ** 2))));
    const norm = Math.hypot(...vector);
    return norm ? vector.map(value => value / norm) : null;
  }
  async function featuresFromBlob(blob) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error('Voice matching needs Web Audio support.');
    const context = new Context();
    try {
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      const mono = new Float32Array(buffer.length);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
      }
      return extract(mono, buffer.sampleRate);
    } finally { await context.close(); }
  }
  function load() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(KEY) || '{}');
      return Object.fromEntries(Object.entries(parsed).filter(([name, vector]) =>
        name.length <= 40 && Array.isArray(vector) && vector.length === 40 &&
        vector.every(value => typeof value === 'number' && Number.isFinite(value))));
    } catch { return {}; }
  }
  function identify(features, voiceprints = load()) {
    if (!features) return { name: 'Unknown', score: 0 };
    let best = { name: 'Unknown', score: 0 };
    for (const [name, print] of Object.entries(voiceprints)) {
      const score = features.reduce((total, value, i) => total + value * print[i], 0);
      if (score > best.score) best = { name, score };
    }
    return best.score >= .90 ? best : { name: 'Unknown', score: best.score };
  }
  window.VoiceSpeakers = {
    extract, identify, featuresFromBlob,
    names: () => Object.keys(load()),
    async match(blob) { try { return identify(await featuresFromBlob(blob)); } catch { return { name: 'Unknown', score: 0 }; } },
    async enroll(name, blob) {
      const trimmed = name.trim().slice(0, 40);
      if (!trimmed || trimmed.toLowerCase() === 'unknown') throw new Error('Enter a speaker name.');
      const features = await featuresFromBlob(blob);
      if (!features) throw new Error('Record at least four seconds of clear speech.');
      window.localStorage.setItem(KEY, JSON.stringify({ ...load(), [trimmed]: features }));
      return trimmed;
    },
    forget() { window.localStorage.removeItem(KEY); },
  };
})();
