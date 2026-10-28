"""Resolve the platform's bundled DejaVu fonts and user font overrides."""
import os
from pathlib import Path


def font(name='DejaVuSans.ttf'):
    explicit = os.environ.get('HB_FONT')
    font_dir = os.environ.get('HB_FONT_DIR')
    folders = ([Path(explicit).parent] if explicit else [])
    if font_dir:
        folders.append(Path(font_dir))
    folders.extend([
        Path(__file__).resolve().parents[1] / 'data' / 'runtime' / 'fonts',
        Path('/usr/share/fonts/truetype/dejavu'),
        Path('/usr/share/fonts/TTF'),
    ])
    if explicit and name == 'DejaVuSans.ttf' and Path(explicit).is_file():
        return str(Path(explicit))
    for folder in folders:
        candidate = folder / name
        if candidate.is_file():
            return str(candidate)
    if explicit and Path(explicit).is_file():
        return str(Path(explicit))
    if name != 'DejaVuSans.ttf':
        return font()
    raise FileNotFoundError(
        'DejaVu fonts are missing. Run the Windows setup, set HB_FONT/HB_FONT_DIR, '
        'or install fonts-dejavu-core / ttf-dejavu on Linux.'
    )
