"""Render the driver's head from hillclimb_car.blend into a portrait sprite.

    blender -b hillclimb_car.blend --python tools/render-driver.py

The model's `HCR_DriverHead` carries the face photo as a texture, so rendering
the head is the most faithful way to get that face into the 2D game: no manual
cropping, no guessing where the UV island sits.

Writes public/assets/driver_head.png (transparent, cropped to alpha bounds).
"""

import json
import math
import os

import bpy
import numpy as np
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "public", "assets")
OUT_PATH = os.path.join(OUT_DIR, "driver_head.png")

HEAD_OBJECTS = ("HCR_DriverHead", "HCR_DriverNeck")
CENTER = Vector((0.0, -0.23, 1.86))
ORTHO_SCALE = 0.52
RES = 512


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"

    for ob in bpy.data.objects:
        if ob.type in {"MESH", "CAMERA", "LIGHT"} and ob.name not in HEAD_OBJECTS:
            if ob.type == "LIGHT":
                continue
            ob.hide_render = True

    for ob in [o for o in bpy.data.objects if o.type == "CAMERA"]:
        bpy.data.objects.remove(ob, do_unlink=True)

    cam_data = bpy.data.cameras.new("DriverCam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = ORTHO_SCALE
    cam = bpy.data.objects.new("DriverCam", cam_data)
    scene.collection.objects.link(cam)
    # front of the car is +Y, so look back along -Y
    cam.location = CENTER + Vector((0.0, 4.0, 0.02))
    cam.rotation_euler = (math.radians(90), 0, math.radians(180))
    scene.camera = cam

    scene.render.resolution_x = RES
    scene.render.resolution_y = RES
    scene.render.resolution_percentage = 100
    scene.render.filepath = OUT_PATH
    bpy.ops.render.render(write_still=True)

    img = bpy.data.images.load(OUT_PATH)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    alpha = px[:, :, 3]
    ys, xs = np.where(alpha > 0.02)
    bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    crop = px[bbox[1] : bbox[3] + 1, bbox[0] : bbox[2] + 1, :]

    out = bpy.data.images.new("driver_head", crop.shape[1], crop.shape[0], alpha=True)
    out.pixels = crop.ravel().tolist()
    out.filepath_raw = OUT_PATH
    out.file_format = "PNG"
    out.save()

    print(
        "DRIVERINFO"
        + json.dumps(
            {
                "size": [int(crop.shape[1]), int(crop.shape[0])],
                "bbox_px": bbox,
                "clipped": bbox[0] <= 0
                or bbox[1] <= 0
                or bbox[2] >= w - 1
                or bbox[3] >= h - 1,
            }
        )
        + "DRIVERINFO"
    )


main()
