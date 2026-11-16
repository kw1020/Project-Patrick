"""Transcribe a 16 kHz mono WAV with faster-whisper; print JSON {text, words:[{start,end,word}]} on the last line."""
import json
import sys
import wave

import numpy as np
from faster_whisper import WhisperModel

wav_path = sys.argv[1]
model_name = sys.argv[2] if len(sys.argv) > 2 else "base.en"

# Read the WAV ourselves (the cutter writes 16 kHz mono s16) so we don't depend on PyAV versions.
with wave.open(wav_path, "rb") as w:
    if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
        raise SystemExit("expected 16 kHz mono 16-bit WAV")
    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0

model = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, _info = model.transcribe(audio, word_timestamps=True, vad_filter=True, beam_size=1)
words, texts = [], []
for seg in segments:
    texts.append(seg.text.strip())
    for w in seg.words or []:
        words.append({"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word.strip()})
print(json.dumps({"text": " ".join(texts).strip(), "words": words}))
