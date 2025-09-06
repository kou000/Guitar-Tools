/* ===== タブ切替 ===== */
const tabTuner = document.getElementById('tab-tuner');
const tabMetro = document.getElementById('tab-metronome');
const panelTuner = document.getElementById('panel-tuner');
const panelMetro = document.getElementById('panel-metronome');

function activate(tab, panel) {
  [tabTuner, tabMetro].forEach(t => t.classList.remove('is-active'));
  [panelTuner, panelMetro].forEach(p => p.classList.remove('is-active'));
  tab.classList.add('is-active');
  panel.classList.add('is-active');
}
tabTuner.addEventListener('click', () => activate(tabTuner, panelTuner));
tabMetro.addEventListener('click', () => activate(tabMetro, panelMetro));

/* ===== チューナー（YIN/CMNDF + 表示安定化） ===== */
let audioCtx = null, mediaStream = null, analyser = null, rafId = null;
let biquadHP = null, biquadLP = null; // ノイズ対策のフィルタ（安定化③）
const enableBtn = document.getElementById('enableMic');
const stopBtn   = document.getElementById('stopMic');
const needle    = document.getElementById('needle');
const freqEl    = document.getElementById('freq');
const centsEl   = document.getElementById('cents');
const noteNameEl= document.getElementById('noteName');

const A4 = 440; // 基準

// 周波数→MIDIノート番号
function freqToNoteNumber(f){ return Math.round(12 * (Math.log(f / A4) / Math.log(2)) + 69); }
// MIDI→音名
function noteNumberToName(n){
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const name = names[(n % 12 + 12) % 12];
  const octave = Math.floor(n / 12) - 1;
  return `${name}${octave}`;
}
// セント差
function centsOff(f, midi){
  const ref = A4 * Math.pow(2, (midi - 69) / 12);
  return 1200 * Math.log(f / ref) / Math.log(2);
}

/* --- YIN/CMNDF（基本周波数推定） ---
   参考：de Cheveigné & Kawahara (2002)
   1) 差分関数 d(τ) を求める
   2) 累積平均で正規化：cmndf(τ)
   3) 閾値(例:0.1)を下回る最初の τ を採用
   4) その近傍で放物線補間して高精度化
*/
function yin(buffer, sampleRate, threshold=0.1) {
  const size = buffer.length;
  const half = size >> 1;

  // 差分関数 d(τ)
  const diff = new Float32Array(half);
  for (let tau=1; tau<half; tau++){
    let sum = 0;
    for (let i=0; i<half; i++){
      const delta = buffer[i] - buffer[i+tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // 累積平均で正規化（CMNDF）
  const cmndf = new Float32Array(half);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau=1; tau<half; tau++){
    runningSum += diff[tau];
    cmndf[tau] = diff[tau] * tau / runningSum;
  }

  // 閾値を下回る最初の τ を探す
  let tau = -1;
  for (let t=2; t<half; t++){
    if (cmndf[t] < threshold) { tau = t; break; }
  }
  if (tau === -1) {
    // 見つからない場合、最小値の位置を採用
    let minV = 1, minT = -1;
    for (let t=2; t<half; t++){
      if (cmndf[t] < minV) { minV = cmndf[t]; minT = t; }
    }
    tau = minT;
    if (tau <= 0) return -1;
  }

  // 放物線補間（精度向上）
  const x0 = (tau <= 1) ? tau : tau - 1;
  const x2 = (tau + 1 < half) ? tau + 1 : tau;
  const s0 = cmndf[x0], s1 = cmndf[tau], s2 = cmndf[x2];
  const a = (s0 + s2 - 2*s1) / 2;
  const b = (s2 - s0) / 2;
  const tauInterp = (a ? tau - b/(2*a) : tau);

  const freq = sampleRate / tauInterp;
  if (!isFinite(freq) || freq <= 0) return -1;
  return freq;
}

/* 表示安定化：
   - 入力にハイパス/ローパス（60Hz以下のハムを除去、1200Hz以上の高域ノイズを除去）
   - cents に指数移動平均 (EMA)
   - さらに中央値フィルタ（最新Nフレームから中央値）でスパイク抑制
*/
let emaCents = null;
const EMA_ALPHA = 0.25;
const MEDIAN_WIN = 5;
const centsHistory = [];

function smoothCents(raw){
  // 1) EMA
  if (emaCents == null) emaCents = raw;
  else emaCents = emaCents + EMA_ALPHA * (raw - emaCents);

  // 2) 中央値フィルタ
  centsHistory.push(emaCents);
  if (centsHistory.length > MEDIAN_WIN) centsHistory.shift();
  const sorted = [...centsHistory].sort((a,b)=>a-b);
  const mid = sorted[Math.floor(sorted.length/2)];
  return mid;
}

async function startTuner(){
  try{
    if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    mediaStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false, noiseSuppression:false}});
    const source = audioCtx.createMediaStreamSource(mediaStream);

    // 安定化③：フィルタ（HPF 60Hz / LPF 1200Hz）
    biquadHP = audioCtx.createBiquadFilter();
    biquadHP.type = 'highpass';
    biquadHP.frequency.value = 60;

    biquadLP = audioCtx.createBiquadFilter();
    biquadLP.type = 'lowpass';
    biquadLP.frequency.value = 1200;

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;

    source.connect(biquadHP).connect(biquadLP).connect(analyser);

    const timeBuf = new Float32Array(analyser.fftSize);

    function tick(){
      analyser.getFloatTimeDomainData(timeBuf);

      // 無音チェック（RMS）
      let rms = 0;
      for (let i=0;i<timeBuf.length;i++){ rms += timeBuf[i]*timeBuf[i]; }
      rms = Math.sqrt(rms / timeBuf.length);
      if (rms < 0.005) {
        // 静かすぎ：リセット表示
        noteNameEl.textContent = '--';
        freqEl.textContent = '--';
        centsEl.textContent = '--';
        needle.style.transform = 'translateX(-50%) rotate(0deg)';
        emaCents = null; centsHistory.length = 0;
        rafId = requestAnimationFrame(tick);
        return;
      }

      // YIN で基本周波数推定
      const f0 = yin(timeBuf, audioCtx.sampleRate, 0.1);
      if (f0 > 0 && f0 < 2000) {
        const midi = freqToNoteNumber(f0);
        const name = noteNumberToName(midi);
        let cents = centsOff(f0, midi);
        cents = Math.max(-100, Math.min(100, cents)); // 極端値の抑制
        const smoothed = smoothCents(cents);
        const displayCents = Math.round(Math.max(-50, Math.min(50, smoothed)));

        noteNameEl.textContent = name;
        freqEl.textContent = f0.toFixed(2);
        centsEl.textContent = (displayCents>0?'+':'') + displayCents;

        const deg = (displayCents / 50) * 45; // ±45°
        needle.style.transform = `translateX(-50%) rotate(${deg}deg)`;
      } else {
        noteNameEl.textContent = '--';
        freqEl.textContent = '--';
        centsEl.textContent = '--';
        needle.style.transform = 'translateX(-50%) rotate(0deg)';
        emaCents = null; centsHistory.length = 0;
      }
      rafId = requestAnimationFrame(tick);
    }
    tick();
  }catch(err){
    alert('マイクにアクセスできませんでした: ' + err.message);
  }
}

function stopTuner(){
  if(rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if(mediaStream){ mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  noteNameEl.textContent = '--'; freqEl.textContent = '--'; centsEl.textContent = '--';
  needle.style.transform = 'translateX(-50%) rotate(0deg)';
  emaCents = null; centsHistory.length = 0;
}

enableBtn.addEventListener('click', async () => {
  enableBtn.disabled = true; stopBtn.disabled = false;
  await startTuner();
});
stopBtn.addEventListener('click', () => {
  stopBtn.disabled = true; enableBtn.disabled = false;
  stopTuner();
});

/* ===== メトロノーム ===== */
let metroCtx = null, metroRunning = false, nextNoteTime = 0, currentBeat = 0, beatsPerBar = 4;
const bpm = document.getElementById('bpm');
const bpmOut = document.getElementById('bpmOut');
const beats = document.getElementById('beats');
const startMetro = document.getElementById('startMetro');
const stopMetro = document.getElementById('stopMetro');
const leds = document.querySelector('.leds');

function initLeds(){
  beatsPerBar = Number(beats.value);
  leds.innerHTML = '';
  for(let i=0;i<beatsPerBar;i++){
    const d = document.createElement('div');
    d.className = 'led';
    leds.appendChild(d);
  }
}
initLeds();

function scheduleClick(time){
  const osc = metroCtx.createOscillator();
  const gain = metroCtx.createGain();
  const downbeat = currentBeat === 0;
  osc.frequency.value = downbeat ? 1200 : 800;
  gain.gain.value = 0.08;
  osc.connect(gain).connect(metroCtx.destination);
  osc.start(time); osc.stop(time + 0.05);
  const idx = currentBeat % beatsPerBar;
  [...leds.children].forEach((el,i)=> el.classList.toggle('active', i===idx));
}

function nextNote(){
  const spb = 60.0 / Number(bpm.value);
  nextNoteTime += spb;
  currentBeat = (currentBeat + 1) % beatsPerBar;
}
function scheduler(){
  if(!metroRunning) return;
  const ahead = 0.1;
  while(nextNoteTime < metroCtx.currentTime + ahead){
    scheduleClick(nextNoteTime);
    nextNote();
  }
  requestAnimationFrame(scheduler);
}

startMetro.addEventListener('click', ()=>{
  if(metroRunning) return;
  if(!metroCtx) metroCtx = new (window.AudioContext || window.webkitAudioContext)();
  currentBeat = beatsPerBar - 1;
  nextNoteTime = metroCtx.currentTime + 0.05;
  metroRunning = true; startMetro.disabled = true; stopMetro.disabled = false;
  scheduler();
});
stopMetro.addEventListener('click', ()=>{
  metroRunning = false; startMetro.disabled = false; stopMetro.disabled = true;
  [...leds.children].forEach(el=> el.classList.remove('active'));
});
bpm.addEventListener('input', ()=> bpmOut.textContent = bpm.value);
beats.addEventListener('change', initLeds);
