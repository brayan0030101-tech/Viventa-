"""Renderiza el borrador vertical (9:16) del UGC Serena del Mar con las fotos reales.
Uso: python3 render_borrador.py <carpeta_fotos> <salida.mp4>
Las fotos se descargan de la galería del proyecto 120 en viventa.co (foto_XXX.webp)."""
import subprocess, sys, os, tempfile

IMG, OUT = sys.argv[1], sys.argv[2]
FONT = "/usr/share/fonts/opentype/inter/Inter-Bold.otf"
W, H, FPS = 1080, 1920, 30

# (foto, segundos, subtítulo = lo que dice la creadora)
SHOTS = [
    ("foto_008", 4.5, "Si vivís afuera y soñás\ncon tu casa en Colombia...\nvení te muestro esto"),
    ("foto_004", 4.0, "Serena del Mar, Cartagena.\n¡Mirá esta entrada, pues!"),
    ("foto_014", 4.5, "Casas de 125 y 160 m²\ncon 4 habitaciones"),
    ("foto_019", 4.5, "Entrá conmigo...\nmirá la luz de esta sala"),
    ("foto_021", 4.0, "Y la sala abre\ndirecto al patio"),
    ("foto_017", 4.5, "Imaginate despertar aquí,\na minutos del mar"),
    ("foto_016", 4.5, "Patio con piscina\nprivada. ¡Qué chimba!"),
    ("foto_010", 4.5, "Y las zonas comunes, parce:\npiscina, jacuzzi..."),
    ("foto_007", 3.5, "gimnasio, yoga, pádel..."),
    ("foto_012", 3.5, "y parque pa' los niños"),
    ("foto_020", 5.0, "Pa' vivir, pa' regalársela\na tu mamá o pa' invertir"),
    ("foto_015", 6.0, "Desde $1.449 millones\nEntrega julio 2029\nEscribile a Viventa 👇"),
]
XF = 0.5  # duración del fundido entre tomas

tmp = tempfile.mkdtemp()
parts = []
for i, (name, dur, text) in enumerate(SHOTS):
    tf = os.path.join(tmp, f"t{i}.txt")
    open(tf, "w").write(text.replace("👇", "").strip())
    d = -1 if i % 2 else 1  # alterna dirección: se siente como caminar y girar
    x = f"(iw-{W})*(0.25+0.5*t/{dur})" if d > 0 else f"(iw-{W})*(0.75-0.5*t/{dur})"
    vf = (
        f"scale=-2:{int(H*1.08)}:flags=lanczos,unsharp=5:5:0.6,"
        f"crop={W}:{H}:x='{x}':y='(ih-{H})/2',"
        "eq=saturation=1.08:contrast=1.03,"
        f"drawtext=fontfile={FONT}:textfile={tf}:fontsize=58:fontcolor=white:"
        "line_spacing=14:text_align=center:x=(w-text_w)/2:y=h*0.68:"
        "box=1:boxcolor=black@0.45:boxborderw=28:"
        f"alpha='min(1,max(0,(t-0.25)/0.3))',"
        f"fps={FPS},format=yuv420p"
    )
    p = os.path.join(tmp, f"p{i}.mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-t", str(dur),
                    "-i", os.path.join(IMG, name + ".webp"), "-vf", vf,
                    "-c:v", "libx264", "-preset", "medium", "-crf", "19", p], check=True)
    parts.append((p, dur))

# Encadena con fundidos
inputs, chain, off, last = [], [], 0.0, "0:v"
for p, _ in parts:
    inputs += ["-i", p]
for i in range(1, len(parts)):
    off += parts[i - 1][1] - XF
    lbl = f"v{i}"
    chain.append(f"[{last}][{i}:v]xfade=transition=fade:duration={XF}:offset={off:.2f}[{lbl}]")
    last = lbl
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(chain),
                "-map", f"[{last}]", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", OUT], check=True)
print("ok", OUT)
