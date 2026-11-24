#!/usr/bin/env python3
"""Render the Fire Counsel brand film from the included stills and narration.

Requires Pillow and imageio-ffmpeg. Run from the repository root:
  python3 tools/make_brand_film.py
"""
from __future__ import annotations

import math
import os
import subprocess
import tempfile
import wave
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "Fire-Counsel-brand-film.mp4"
W, H, FPS = 1280, 720, 24
DURATION = 45.0
FADE = 0.72

ASSETS = {
    "library": Image.open(ROOT / "video-assets/law-library.jpg").convert("RGB"),
    "bar": Image.open(ROOT / "video-assets/call-to-bar.jpg").convert("RGB"),
    "exam": Image.open(ROOT / "video-assets/exam-hall.jpg").convert("RGB"),
}
LOGO = Image.open(ROOT / "assets/fire-counsel-512.png").convert("RGB").crop((172, 158, 342, 354))
FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")
FONT_REG = str(FONT_DIR / "DejaVuSans.ttf")
FONT_BOLD = str(FONT_DIR / "DejaVuSans-Bold.ttf")


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)


def ease(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def cubic(p0, p1, p2, p3, t):
    u = 1 - t
    return (u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0],
            u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1])


def glow(canvas: Image.Image, xy, radius: int, color=(255, 96, 16), amount=0.35):
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x, y = xy
    d.ellipse((x-radius, y-radius, x+radius, y+radius), fill=(*color, int(175*amount)))
    layer = layer.filter(ImageFilter.GaussianBlur(radius * 0.68))
    canvas.alpha_composite(layer)


# Pre-render reusable lighting layers; avoid per-frame pixel loops during encoding.
_small_grad = Image.new("RGBA", (320, 180), (0, 0, 0, 0))
_gd = ImageDraw.Draw(_small_grad)
for _x in range(320):
    _gd.line((_x, 0, _x, 179), fill=(3, 5, 12, int(165 * (1 - min(1, _x * 4 / 850)) ** 1.5)))
LEFT_GRAD = _small_grad.resize((W, H), Image.Resampling.BILINEAR)
_small_v = Image.new("L", (320, 180), 0)
_vp = _small_v.load()
for _y in range(180):
    for _x in range(320):
        _dx = (_x - 160) / 160
        _dy = (_y - 90) / 90
        _vp[_x, _y] = int(255 * min(1, (_dx*_dx*.43 + _dy*_dy*.57) ** 1.25) * .34)
VIGNETTE = _small_v.resize((W, H), Image.Resampling.BILINEAR)


def add_vignette(im: Image.Image, strength=0.5):
    if strength == .34:
        mask = VIGNETTE
    else:
        mask = VIGNETTE.point(lambda p: int(min(255, p * strength / .34)))
    shade = Image.new("RGBA", (W, H), (1, 1, 6, 0))
    shade.putalpha(mask)
    im.alpha_composite(shade)


def bg_still(src: Image.Image, t: float, direction=1) -> Image.Image:
    # A very restrained slow push and drift lends movement without making the still feel synthetic.
    zoom = 1.035 + 0.055 * ease(t)
    cw, ch = int(src.width / zoom), int(src.height / zoom)
    drift = (t - .5) * .10 * direction
    cx = src.width * (.5 + drift)
    cy = src.height * (.5 + (t-.5)*.018)
    box = (int(cx-cw/2), int(cy-ch/2), int(cx+cw/2), int(cy+ch/2))
    crop = src.crop(box).resize((W, H), Image.Resampling.LANCZOS)
    im = crop.convert("RGBA")
    overlay = Image.new("RGBA", (W,H), (4, 5, 12, 62))
    im.alpha_composite(overlay)
    # Soft, pre-rendered left-side gradient behind titles.
    im.alpha_composite(LEFT_GRAD)
    add_vignette(im, .34)
    return im


def line_wrap(text: str, fnt, max_width: int, draw: ImageDraw.ImageDraw):
    words, lines, current = text.split(), [], ""
    for word in words:
        candidate = (current + " " + word).strip()
        if draw.textbbox((0,0), candidate, font=fnt)[2] <= max_width or not current:
            current = candidate
        else:
            lines.append(current); current = word
    if current: lines.append(current)
    return lines


def label(draw, x, y, text, alpha=255):
    draw.text((x,y), text.upper(), font=font(16, True), fill=(255,174,82,alpha), stroke_width=0)


def title(im: Image.Image, kicker: str, headline: str, sub: str = "", y=478, align="left", alpha=255):
    layer = Image.new("RGBA", (W,H), (0,0,0,0)); d = ImageDraw.Draw(layer)
    x = 100 if align == "left" else W//2
    label(d, x, y, kicker, alpha)
    headline_font = font(43, True)
    lines = line_wrap(headline, headline_font, 820 if align=="left" else 1120, d)
    yy = y + 34
    for ln in lines:
        d.text((x,yy), ln, font=headline_font, fill=(255,255,252,alpha), anchor="la" if align=="left" else "ma")
        yy += 54
    if sub:
        sub_font = font(21)
        d.text((x, yy+7), sub, font=sub_font, fill=(234,231,225, int(alpha*.92)), anchor="la" if align=="left" else "ma")
    im.alpha_composite(layer)


def flame_points(cx, top, bottom, width, phase, detail=45):
    # Three flowing cubic sections make a hand-shaped flame silhouette.
    sway = math.sin(phase*2.2) * width*.075
    left = [cubic((cx,top), (cx-width*.34+sway,top+width*.34), (cx-width*.60,bottom-width*.13), (cx,bottom), i/detail) for i in range(detail+1)]
    right = [cubic((cx,bottom), (cx+width*.56,bottom-width*.2), (cx+width*.34-sway,top+width*.28), (cx,top), i/detail) for i in range(detail+1)]
    return left + right


def draw_flame(im: Image.Image, cx: int, cy: int, scale: float, time: float):
    # Layered animated teardrops, rendered with soft bloom so the logo fire visibly burns.
    layer = Image.new("RGBA", (W,H), (0,0,0,0))
    flick = math.sin(time*9.3)*.045 + math.sin(time*5.7+1)*.024
    outer_w = int(146*scale*(1+flick)); outer_h = int(208*scale*(1-flick*.35))
    top, bottom = cy-outer_h//2, cy+outer_h//2
    d = ImageDraw.Draw(layer)
    d.polygon(flame_points(cx, top, bottom, outer_w, time), fill=(255,62,10,248))
    w2 = int(outer_w*.70); h2 = int(outer_h*.73)
    d.polygon(flame_points(cx, cy+int(13*scale)-h2//2, cy+int(13*scale)+h2//2, w2, time+1.2), fill=(255,153,29,255))
    w3 = int(outer_w*.39); h3 = int(outer_h*.40)
    d.polygon(flame_points(cx, cy+int(43*scale)-h3//2, cy+int(43*scale)+h3//2, w3, time+2.3), fill=(255,225,118,255))
    d.ellipse((cx-int(18*scale), cy+int(43*scale), cx+int(19*scale), cy+int(62*scale)), fill=(255,250,225,255))
    bloom = layer.filter(ImageFilter.GaussianBlur(max(4,int(21*scale))))
    bloom.putalpha(bloom.getchannel("A").point(lambda p: int(p*.58)))
    im.alpha_composite(bloom); im.alpha_composite(layer)


def draw_hex(im, cx, cy, r, alpha=255):
    d = ImageDraw.Draw(im)
    pts = [(cx,cy-r),(cx+int(.866*r),cy-r//2),(cx+int(.866*r),cy+r//2),(cx,cy+r),(cx-int(.866*r),cy+r//2),(cx-int(.866*r),cy-r//2)]
    d.polygon(pts, fill=(18,19,30,int(alpha*.88)), outline=(143,119,113,alpha), width=2)
    d.line(pts+[pts[0]], fill=(255,109,36,int(alpha*.68)), width=2, joint="curve")


def scene_intro(t):
    im = Image.new("RGBA", (W,H), (3,3,8,255))
    cx, cy = W//2, 290
    # ember bloom and drifting sparks
    glow(im,(cx,cy),235,(255,72,14),.48)
    draw_hex(im,cx,cy,220)
    draw_flame(im,cx,cy+16,1.0,t)
    d=ImageDraw.Draw(im)
    for i in range(18):
        seed=i*17.71
        x=cx+math.sin(seed+t*.45)*(65+(i%4)*27)
        y=cy+math.cos(seed*1.7+t*.8)*(115+(i%5)*18)
        r=1.4+(i%3)*.7
        a=int(90+115*(.5+.5*math.sin(t*4+i)))
        d.ellipse((x-r,y-r,x+r,y+r),fill=(255,181,74,a))
    # Brand lockup builds in after the mark.
    fade=ease((t-1.4)/1.2)
    if fade>0:
        lay=Image.new("RGBA",(W,H),(0,0,0,0)); dd=ImageDraw.Draw(lay)
        dd.text((cx,535),"FIRE COUNSEL",font=font(35,True),fill=(255,255,251,int(255*fade)),anchor="mm")
        dd.text((cx,578),"IGNITE YOUR LEGAL INTELLIGENCE",font=font(14,True),fill=(236,168,92,int(255*fade)),anchor="mm")
        im.alpha_composite(lay)
    return im


def scene_library(t):
    im=bg_still(ASSETS["library"],t,1)
    title(im,"For the work behind the dream","A future advocate in the making.","One page, one question, one breakthrough at a time.",y=476)
    return im


def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box,radius=radius,fill=fill,outline=outline,width=width)


def draw_ui_panel(im, t):
    # Product vignette, based on the actual Fire Counsel AI feature set and visual system.
    panel=Image.new("RGBA",(W,H),(0,0,0,0)); d=ImageDraw.Draw(panel)
    x0,y0,x1,y1=175,115,1105,552
    rounded(d,(x0+7,y0+12,x1+7,y1+12),22,(0,0,0,155))
    rounded(d,(x0,y0,x1,y1),22,(15,17,25,250),(255,255,255,45),1)
    rounded(d,(x0,y0,x0+245,y1),22,(22,23,33,255))
    d.rectangle((x0+215,y0,x0+245,y1),fill=(22,23,33,255))
    # icon + wordmark
    rounded(d,(x0+22,y0+19,x0+60,y0+57),12,(104,42,19,255))
    d.text((x0+41,y0+38),"F",font=font(22,True),fill=(255,180,93,255),anchor="mm")
    d.text((x0+72,y0+23),"FIRE COUNSEL",font=font(12,True),fill=(255,246,235,255))
    d.text((x0+72,y0+42),"AI STUDY STUDIO",font=font(9,True),fill=(179,160,149,255))
    d.line((x0+16,y0+72,x0+225,y0+72),fill=(255,255,255,26),width=1)
    d.text((x0+22,y0+91),"YOUR STUDY TOOLS",font=font(10,True),fill=(196,160,130,255))
    nav=[("✦","Ask a legal question"),("§","Analyse a case"),("▤","Create exam notes"),("✓","Practice questions")]
    for j,(ic,txt) in enumerate(nav):
        yy=y0+116+j*48
        if j==0: rounded(d,(x0+13,yy-5,x0+230,yy+35),10,(111,51,24,170))
        d.text((x0+28,yy+4),ic,font=font(16,True),fill=(255,180,93,255))
        d.text((x0+55,yy+7),txt,font=font(12),fill=(245,239,232,240))
    # conversation pane
    d.text((x0+275,y0+27),"Fire Counsel",font=font(18,True),fill=(255,251,245,255))
    d.text((x0+275,y0+55),"Your AI study companion for law",font=font(11),fill=(167,163,168,255))
    rounded(d,(x0+274,y0+93,x1-28,y0+153),12,(36,37,46,255))
    d.text((x0+294,y0+106),"Explain consideration in contract law simply.",font=font(13),fill=(249,246,240,255))
    rounded(d,(x0+274,y0+170,x1-28,y0+319),14,(28,30,39,255),(255,255,255,22),1)
    d.text((x0+294,y0+184),"A SIMPLE WAY TO THINK ABOUT IT",font=font(10,True),fill=(255,173,83,255))
    answer=["Consideration is the value each side gives or promises", "in exchange for the other side's promise. It may be an", "act, a promise, or sometimes choosing not to do something."]
    for j,line in enumerate(answer): d.text((x0+294,y0+209+j*23),line,font=font(12),fill=(234,231,226,255))
    # Practice chip and composer
    rounded(d,(x0+274,y0+332,x0+456,y0+362),15,(103,49,22,180),(250,141,65,85),1)
    d.text((x0+365,y0+347),"＋  Make exam notes",font=font(10,True),fill=(255,213,168,255),anchor="mm")
    rounded(d,(x0+274,y0+379,x1-28,y0+419),12,(35,36,46,255),(255,255,255,35),1)
    d.text((x0+294,y0+392),"Ask Fire Counsel anything…",font=font(11),fill=(153,151,158,255))
    d.ellipse((x1-72,y0+385,x1-38,y0+419),fill=(210,91,35,255))
    d.text((x1-55,y0+402),"↑",font=font(17,True),fill=(255,250,244,255),anchor="mm")
    im.alpha_composite(panel)
    return im


def scene_ai(t):
    im=Image.new("RGBA",(W,H),(6,7,13,255))
    # faint warm ambient halo behind the crisp, legible app showcase
    glow(im,(W//2,H//2),330,(197,69,27),.2)
    draw_ui_panel(im,t)
    return im


def scene_exam(t):
    im=bg_still(ASSETS["exam"],t,-1)
    title(im,"For the moment it all comes together","Feel more ready for the exam hall.","Clearer notes. Better practice. A steadier next step.",y=478)
    return im


def scene_books(t):
    # A designed study-desk interlude, with legible Nigerian law study materials.
    im=bg_still(ASSETS["library"],1-t, -1)
    veil=Image.new("RGBA",(W,H),(4,5,12,148)); im.alpha_composite(veil)
    d=ImageDraw.Draw(im)
    # Warm pool of desk light
    glow(im,(690,345),290,(255,160,69),.22); d=ImageDraw.Draw(im)
    # page stack and book objects
    d.polygon([(338,414),(905,414),(960,454),(389,454)],fill=(210,197,171,255))
    d.polygon([(389,454),(960,454),(960,478),(389,478)],fill=(173,157,130,255))
    d.polygon([(345,393),(900,393),(953,424),(390,424)],fill=(71,34,26,255))
    d.polygon([(390,424),(953,424),(953,451),(390,451)],fill=(43,23,23,255))
    d.polygon([(345,393),(390,424),(390,451),(345,420)],fill=(119,50,31,255))
    d.text((645,411),"NIGERIAN CONSTITUTIONAL LAW",font=font(16,True),fill=(255,223,169,255),anchor="mm")
    d.line((416,437,913,437),fill=(204,157,96,180),width=1)
    # upper book
    d.polygon([(392,302),(871,302),(921,334),(439,334)],fill=(224,215,192,255))
    d.polygon([(439,334),(921,334),(921,386),(439,386)],fill=(30,62,62,255))
    d.polygon([(392,302),(439,334),(439,386),(392,354)],fill=(21,46,46,255))
    rounded(d,(478,342,880,375),4,(30,62,62,255),(191,164,112,210),1)
    d.text((679,351),"CONTRACT LAW",font=font(21,True),fill=(243,225,184,255),anchor="mm")
    # legal pad with quick handwritten-looking lines
    rounded(d,(790,200,1002,291),8,(227,216,189,245))
    for k in range(4):
        d.line((814,220+k*16,975-(k%2)*19,220+k*16),fill=(120,119,112,170),width=2)
    d.line((819,213,819,279),fill=(184,92,61,155),width=1)
    # Quietly animated ember at the edge
    ex=1070+int(8*math.sin(t*2)); ey=206+int(11*math.sin(t*1.5))
    glow(im,(ex,ey),44,(255,130,34),.42); ImageDraw.Draw(im).ellipse((ex-3,ey-3,ex+3,ey+3),fill=(255,205,122,220))
    title(im,"Built around the way you study","Your notes. Your cases. Your next breakthrough.","Bring legal questions and study materials together.",y=493)
    return im


def scene_bar(t):
    im=bg_still(ASSETS["bar"],t,1)
    title(im,"From first principles to the day you are called","Keep your fire burning.","Fire Counsel — ignite your legal intelligence.",y=480)
    return im


def scene_outro(t):
    im=Image.new("RGBA",(W,H),(4,4,10,255)); cx,cy=W//2,273
    glow(im,(cx,cy),260,(255,73,13),.43)
    draw_hex(im,cx,cy,178)
    # Project's own mark is visible inside a newly animated burning halo.
    draw_flame(im,cx,cy+17,.66,t)
    # Original logo crop sits behind the moving burn; use screen/soft alpha to retain the product mark.
    mark=LOGO.resize((144,166),Image.Resampling.LANCZOS).convert("RGBA")
    mark.putalpha(mark.convert("L").point(lambda p: 0 if p < 28 else min(215, p)))
    # Keep the user's hexagonal ember recognizable while letting the animated flame remain vivid.
    im.alpha_composite(mark,(cx-mark.width//2,cy-mark.height//2))
    # Draw the flame once more above the mark for the conspicuous burning effect.
    draw_flame(im,cx,cy+16,.67,t)
    d=ImageDraw.Draw(im)
    d.text((cx,495),"FIRE COUNSEL",font=font(38,True),fill=(255,255,250,255),anchor="mm")
    d.text((cx,541),"IGNITE YOUR LEGAL INTELLIGENCE",font=font(14,True),fill=(255,174,86,255),anchor="mm")
    rounded(d,(cx-122,584,cx+122,628),22,(131,56,23,185),(255,154,78,140),1)
    d.text((cx,606),"LEARN  ·  PRACTICE  ·  GROW",font=font(12,True),fill=(255,244,228,255),anchor="mm")
    return im


SCENES = [
    (0.0, 5.2, scene_intro),
    (5.2, 12.3, scene_library),
    (12.3, 19.3, scene_ai),
    (19.3, 25.8, scene_exam),
    (25.8, 32.4, scene_books),
    (32.4, 38.4, scene_bar),
    (38.4, 45.0, scene_outro),
]


def frame_at(t):
    idx=next((i for i,(a,b,_) in enumerate(SCENES) if a <= t < b),len(SCENES)-1)
    a,b,fn=SCENES[idx]
    current=fn((t-a)/(b-a))
    if idx < len(SCENES)-1:
        fade_start=SCENES[idx+1][0]
        if t >= fade_start-FADE:
            u=ease((t-(fade_start-FADE))/FADE)
            na,nb,nfn=SCENES[idx+1]
            nxt=nfn((t-na)/(nb-na))
            current=Image.blend(current.convert("RGB"),nxt.convert("RGB"),u).convert("RGBA")
    return current.convert("RGB")


def make_music(path: Path):
    # Original, royalty-free ambient bed: gentle synthesized warm chords, no borrowed music.
    sr=22050; n=int(sr*DURATION)
    chords=[(110.0,164.81,220.0),(98.0,146.83,196.0),(130.81,196.0,261.63),(110.0,164.81,220.0)]
    with wave.open(str(path),"wb") as wf:
        wf.setnchannels(2); wf.setsampwidth(2); wf.setframerate(sr)
        chunk=8192
        for start in range(0,n,chunk):
            frames=[]
            for i in range(start,min(n,start+chunk)):
                t=i/sr; chord=chords[int(t//11.25)%len(chords)]
                fade=min(1,t/2,(DURATION-t)/2)
                pad=sum(math.sin(2*math.pi*f*t + .12*math.sin(2*math.pi*.11*t)) for f in chord)/3
                shimmer=.10*math.sin(2*math.pi*440*t)*max(0,math.sin(2*math.pi*t/5))**12
                val=(pad*.055+shimmer*.018)*max(0,fade)
                left=max(-1,min(1,val*(.93+.05*math.sin(t*.4))))
                right=max(-1,min(1,val*(.93+.05*math.cos(t*.37))))
                frames.append((int(left*32767),int(right*32767)))
            wf.writeframes(b"".join(int(a).to_bytes(2,'little',signed=True)+int(b).to_bytes(2,'little',signed=True) for a,b in frames))


def main():
    ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
    narr=ROOT/"video-assets/fire-counsel-narration.mp3"
    if not narr.exists(): raise FileNotFoundError(narr)
    with tempfile.TemporaryDirectory(prefix="fire-counsel-film-") as td:
        td=Path(td); raw=td/"frames.rgb"; music=td/"ambient.wav"
        make_music(music)
        cmd=[ffmpeg,"-y","-hide_banner","-loglevel","error","-f","rawvideo","-pix_fmt","rgb24","-s",f"{W}x{H}","-r",str(FPS),"-i","-","-i",str(narr),"-i",str(music),"-filter_complex","[1:a]volume=1.0[voice];[2:a]volume=0.22[bed];[voice][bed]amix=inputs=2:duration=longest:dropout_transition=1,alimiter=limit=0.92[a]","-map","0:v:0","-map","[a]","-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p","-c:a","aac","-b:a","160k","-t",str(DURATION),"-movflags","+faststart",str(OUT)]
        proc=subprocess.Popen(cmd,stdin=subprocess.PIPE)
        try:
            for n in range(int(DURATION*FPS)):
                proc.stdin.write(frame_at(n/FPS).tobytes())
                if n%240==0: print(f"Rendering {n/(DURATION*FPS):.0%}",flush=True)
            proc.stdin.close()
            code=proc.wait()
            if code: raise subprocess.CalledProcessError(code,cmd)
        except BaseException:
            proc.kill(); raise
    print(f"Wrote {OUT} ({OUT.stat().st_size/1024/1024:.1f} MB)")

if __name__ == "__main__": main()
