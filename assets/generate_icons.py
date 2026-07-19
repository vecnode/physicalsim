"""Generates the physicalsim app icons: a solid black circle on a
transparent background, at the two sizes the native shell needs.
Run once with `python assets/generate_icons.py`; not part of the build.
"""

from PIL import Image, ImageDraw


def circle(size: int, margin_ratio: float = 0.06) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin = round(size * margin_ratio)
    draw.ellipse([margin, margin, size - 1 - margin, size - 1 - margin], fill=(0, 0, 0, 255))
    return img


def main() -> None:
    large = circle(64)
    small = circle(16)

    large.save("assets/app_icon.ico", sizes=[(64, 64)])
    small.save("assets/app_icon_small.ico", sizes=[(16, 16)])
    large.save("assets/app_icon.png")


if __name__ == "__main__":
    main()
