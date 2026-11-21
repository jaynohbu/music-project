# Theme backgrounds

`assets/theme_rock.jpg`, `theme_pop.jpg`, `theme_jazz_band.jpg` and `theme_christian.jpg` are rendered by these scripts: stage lights through haze, bloom, bokeh and silhouettes, drawn with numpy and Pillow. They are not photos.

```bash
python3 -m venv venv && venv/bin/pip install numpy pillow scipy
venv/bin/python rock.py   # writes theme_rock.jpg here; likewise pop.py, jazz.py, worship.py
```

Copy the output to `assets/` with JPEG quality 80. The heavy metal background (`theme_heavy_metal.png`) was supplied separately.
