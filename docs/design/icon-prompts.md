# Промпты для пиктограммы приложения

Промпты написаны по-английски: генераторы картинок понимают так точнее. Каждый промпт самодостаточный, его можно
вставить в ChatGPT целиком. Удобный порядок работы:

1. Вставить один из промптов 1-8. Попросить 3-4 варианта: «Give me 4 different takes».
2. Понравившийся вариант довести уточняющими промптами из раздела «Доводка».
3. Проверить мелкий размер: уменьшить картинку до 48 px и посмотреть, читается ли форма.
4. Сохранить итог как PNG 1024×1024 и положить в репозиторий, остальные размеры делаются из него.

Что важно для пиктограммы и уже записано в каждом промпте:

- квадрат 1024×1024, фон залит до краёв, без прозрачности и без скруглённых углов (iOS и Android скругляют сами);
- главное изображение в центральном круге диаметром 80% (Android обрезает края по маске);
- никаких букв, слов и цифр;
- одна простая форма, 2-3 цвета, читается в размере 48 px.

## 1. Дом из пузыря сообщения

```text
Design a mobile app icon for a private family messenger. Concept: a single speech bubble whose top edge is shaped
like a simple house roof, so the bubble reads as both "message" and "home". Flat vector style, bold geometric shapes,
no outlines, no gradients, no shadows, no text or letters. Two colours only: a warm off-white shape on a solid deep
teal-green background (#2f5d50). The shape is centred and fits inside the central 80% circle of the canvas. Square
1024x1024, background fills the whole square edge to edge, no rounded corners, no transparency, no mockup, no device
frame. It must stay recognisable at 48 px.
```

## 2. Семья из трёх пузырей

```text
Design a mobile app icon for a family chat app. Concept: three rounded speech bubbles of different sizes, two larger
and one small, overlapping slightly and leaning toward each other like a family standing together. Flat vector, soft
geometric shapes, no faces, no text, no outlines. Palette: warm cream background (#f6f3ee), bubbles in terracotta,
mustard yellow and deep green, with slightly darker tones where they overlap. Composition centred inside the central
80% circle. Square 1024x1024, background fills the whole square, no rounded corners, no transparency, no mockup.
Simple enough to read at 48 px.
```

## 3. Окно с тёплым светом

```text
Design a mobile app icon for a home-hosted family messenger. Concept: a single cosy window glowing with warm light at
night, with the window panes forming a subtle speech bubble shape. Minimal flat illustration, large simple shapes, no
text, no people. Palette: deep midnight blue background, warm amber-yellow window, a thin cream frame. Centred, inside
the central 80% circle. Square 1024x1024, full-bleed background, no rounded corners, no transparency, no mockup. Must
read clearly at 48 px as one glowing shape.
```

## 4. Пузырь с замочной скважиной

```text
Design a mobile app icon for an end-to-end encrypted family chat. Concept: one friendly rounded speech bubble with a
small keyhole cut out in its centre. Calm and trustworthy, not technical or corporate. Flat vector, no gradients, no
text, no padlock, no shield. Two colours: a soft white bubble on a solid muted indigo background, the keyhole shows
the background colour. Centred inside the central 80% circle. Square 1024x1024, background to the edges, no rounded
corners, no transparency, no mockup. Recognisable at 48 px.
```

## 5. Гнездо с тремя точками

```text
Design a mobile app icon for a family messenger. Concept: a simple round nest seen from above, drawn with a few thick
curved strokes, holding three small eggs in a row that also read as the three dots of a "typing" indicator. Warm,
gentle, hand-made feeling but still geometric and clean. Flat vector, no text, no birds. Palette: sand-beige
background, warm brown nest, three cream dots. Centred inside the central 80% circle. Square 1024x1024, full-bleed
background, no rounded corners, no transparency, no mockup. Works at 48 px.
```

## 6. Чашка с паром

```text
Design a mobile app icon for a family chat app, inspired by talking at the kitchen table. Concept: a simple tea cup
seen from the side, with a single curl of steam rising from it that forms a small speech bubble. Flat vector, rounded
friendly shapes, no text, no saucer details. Palette: soft sage green background, cream cup, steam bubble in a
slightly lighter cream. Centred inside the central 80% circle. Square 1024x1024, background fills the canvas, no
rounded corners, no transparency, no mockup. Clear at 48 px.
```

## 7. Переплетённые нити

```text
Design an abstract mobile app icon for a family messenger. Concept: three thick ribbons of different colours woven
into one simple knot or braid that forms a rounded, bubble-like silhouette, suggesting family ties and conversation.
Modern flat vector, smooth curves, equal stroke width, no text, no letters. Palette: off-white background with
ribbons in coral, teal and golden yellow. Centred inside the central 80% circle. Square 1024x1024, full-bleed, no
rounded corners, no transparency, no mockup. The overall silhouette must be readable at 48 px.
```

## 8. Сердце из двух пузырей

```text
Design a mobile app icon for a private family chat. Concept: two speech bubbles facing each other, one slightly
larger, whose overlapping area forms a small heart. Subtle and warm, not romantic or childish. Flat vector, simple
geometry, no text, no faces. Palette: solid warm coral background, bubbles in cream and soft peach, heart in a deeper
coral. Centred inside the central 80% circle. Square 1024x1024, background to the edges, no rounded corners, no
transparency, no mockup. Recognisable at 48 px.
```

## Доводка

Эти промпты отправляются следом, в том же разговоре, после того как появился вариант, который нравится.

Упростить для мелкого размера:

```text
Simplify this icon: fewer details, thicker shapes, larger main figure. Show it at 1024 px and next to it the same
icon reduced to 48 px so I can check that it still reads.
```

Подобрать цвета:

```text
Keep the exact same shapes and composition. Show 6 colour variants side by side: deep green, blue, violet, rose,
orange and graphite backgrounds, each with a matching light foreground.
```

Сделать строже или теплее:

```text
Keep the concept but make it calmer and more minimal, like an icon from a well-designed system app: perfect geometry,
generous empty space, at most two colours.
```

```text
Keep the concept but make it warmer and friendlier: softer corners, slightly rounder proportions, warmer colours.
```

Одноцветная версия (нужна для значка в строке состояния Android и для маски):

```text
Make a monochrome version of this icon: the main figure as a single solid white silhouette on a transparent
background, no inner details that would disappear at 24 px. PNG, 1024x1024.
```

Итоговый файл:

```text
Give me the final icon as a PNG, exactly 1024x1024, background filling the whole square, no rounded corners, no
transparency, no text, no border, with the main figure inside the central 80% circle.
```

## Что сделать с выбранной картинкой

Положить PNG 1024×1024 (и одноцветную версию, если получилась) в `apps/web/public/` и сказать об этом: из неё
делаются `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, вариант с маской для Android и `icon.svg`.
