"""Turn a spoken wav into other voices with Applio's RVC (CPU).

  tools\\rvc\\venv312\\Scripts\\python.exe scripts\\rvc-convert.py --in speech.wav --out-prefix out --voices peter-375:-12,mr-krabs:-12

Each voice is a folder in models\\ with model.pth (+ model.index). The number after the colon is
the pitch shift in semitones (a female base voice into a male one is about -12).
"""
import argparse
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.join(ROOT, "tools", "rvc")  # the environment, Applio and models live in tools\rvc (not in git)
APPLIO = os.path.join(HERE, "applio")

ap = argparse.ArgumentParser()
ap.add_argument("--in", dest="inp", required=True)
ap.add_argument("--out-prefix", required=True)
ap.add_argument("--voices", required=True)
ap.add_argument("--index-rate", type=float, default=0.6)
args = ap.parse_args()

inp = os.path.abspath(args.inp)
prefix = os.path.abspath(args.out_prefix)
os.chdir(APPLIO)  # Applio finds its own models relative to here
sys.path.insert(0, APPLIO)
from rvc.infer.infer import VoiceConverter  # noqa: E402

vc = VoiceConverter()
for item in args.voices.split(","):
    name, _, pitch = item.partition(":")
    folder = os.path.join(HERE, "models", name)
    index = os.path.join(folder, "model.index")
    out = f"{prefix}_{name}.wav"
    t0 = time.time()
    vc.convert_audio(
        audio_input_path=inp, audio_output_path=out,
        model_path=os.path.join(folder, "model.pth"), index_path=index if os.path.exists(index) else "",
        pitch=int(pitch or 0), f0_method="rmvpe", index_rate=args.index_rate, protect=0.33,
        volume_envelope=1.0, export_format="WAV", embedder_model="contentvec",
    )
    print(f"DONE {name} pitch {pitch or 0} -> {out} in {time.time() - t0:.0f}s", flush=True)
