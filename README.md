# Guitar Tools — チューナー & メトロノーム（YIN/CMNDF 版）

ブラウザで使えるギターチューナーとメトロノーム。
- **YIN/CMNDF** で基本周波数推定
- 表示安定化：ハイパス/ローパス、EMA、中央値フィルタ
- 最寄りの半音名（例: A4）に対し **±セント差** を表示
- HTTPS (GitHub Pages / Vercel) で動作。マイク許可が必要

## 使い方
1. `index.html`, `style.css`, `script.js` を同じディレクトリに設置
2. GitHub → Repository → Settings → **Pages** → Deploy from a branch (main/root)
3. 公開URLでアクセスし、**マイクを有効化** を押す

## 補足
- 低音やノイズ下での精度を重視して YIN に変更
- 入力チェーンに **HPF 60Hz / LPF 1200Hz** を追加
- セント表示は EMA + 中央値で揺れを抑制
- 必要に応じて YIN の `threshold` を 0.05～0.2 で微調整すると安定性/追従性のバランスを取れます
