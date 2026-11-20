# Illustrations of the home page

Generated with the MiniMax image model (`mmx image generate`, model image-01), then cut and converted to WebP
with ImageMagick and `cwebp`. Not copied into `dist/` (this file only).

| File | What | How |
| --- | --- | --- |
| `hero-day.webp` | The panorama in the light theme: the family at the kitchen table on the right, an empty wall on the left for the text | Generated at 2048x880, scaled to 1800 px wide |
| `hero-night.webp` | The same panorama at night (dark theme) | Not generated: `hero-day` relit with ImageMagick. A blue night grade, the original colours kept in a soft ellipse around the table (the lamp light), a warm glow above it, the window darkened from the top, a few stars |
| `step-*.webp` | The four steps of "How it works" | Generated square, scaled to 480 px; `step-server` cut at the bottom (the model wrote letters there) and padded back to a square |
| `icon-*.webp` | Icons of the feature tiles | Generated square, cut to the object, the cream background turned white (each channel divided by the background colour) so that `mix-blend-mode: multiply` in `site.css` puts them on any plate colour |

Common style of the prompts: "warm hand-drawn gouache children's book illustration, terracotta, cream and sage green
palette, soft paper texture, no text, no letters". The hero prompt asked for "the family in the right third of the
picture, the left half a calm plain wall with lots of empty space": the text of the home page lies on that wall,
behind a veil (`.hero::before`).

A new picture should keep the same composition (people on the right, an empty left half) and the same palette. The
model does not keep the same people between generations, so the night picture is made from the day one.
