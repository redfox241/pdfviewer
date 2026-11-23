# Noto Sans SC Regular

`NotoSansSC-Regular.ttf` is a static TrueType instance used only when a
print/export job contains written notes. It is subsetted at export time by
`@pdf-lib/fontkit`, so the generated PDFs only embed the characters actually
used. The font is not loaded during ordinary reading.

Source: https://github.com/notofonts/noto-cjk at commit `f8d157532`
(`Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf`), instantiated with
FontTools 4.66.1:

```sh
fonttools varLib.instancer NotoSansSC-VF.ttf wght=400 --static \
  --update-name-table --no-recalc-timestamp \
  --output NotoSansSC-Regular.ttf
```

License: SIL Open Font License 1.1, see `OFL-NotoSansSC.txt`.
