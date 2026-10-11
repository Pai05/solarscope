"""In-site help assistant: a knowledge base about using SolarScope and a small retrieval engine over it.

Works offline with no API key: a question is matched to the best topics by keyword, synonym and typo-tolerant
word overlap (rarer words count more). The same topics are the grounding text for the optional Claude-powered
answers in app.py. Keep the answers in step with the UI labels when the pages change.
"""
from __future__ import annotations

import difflib
import math
import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Topic:
    id: str
    title: str
    questions: tuple[str, ...]   # typical ways people ask
    keywords: tuple[str, ...]
    answer: str                  # plain text; "1. " lines become a list, **x** bold, in the chat widget
    related: tuple[str, ...] = field(default=())


TOPICS: tuple[Topic, ...] = (
    Topic("overview", "What SolarScope does",
          ("what is solarscope", "what does this website do", "how does this site work", "how to use this website", "help"),
          ("solarscope", "website", "site", "overview", "about", "start", "begin", "use", "work"),
          "SolarScope tells you how many solar panels fit on your roof and what they will save.\n"
          "There are two ways to measure the roof:\n"
          "1. **Phone scan** (phone icon in the top bar): measure the roof corners with your phone camera (AR), "
          "or type the roof length and width.\n"
          "2. **Image** (picture icon): upload a top-down drone or aerial photo; the AI marks the usable roof.\n"
          "Then add obstructions (water tanks, stair rooms), set your location and press **Place panels & compute report**. "
          "You get the panel layout, system size (kWp), yearly units, savings, cost after the PM Surya Ghar subsidy and payback. "
          "Have a fixed budget? Enter it in **Budget (optional)** (or tell me, e.g. \"I have only 1 lakh\") and the plan is "
          "sized to fit it. Finally use **Find solar installers near me** to contact installers.",
          ("phone_scan", "image_page", "budget", "report_read")),
    Topic("phone_scan", "Phone scan page, step by step",
          ("how to use phone scan", "how do i measure my roof", "scan page steps", "measure roof with phone"),
          ("phone", "scan", "measure", "roof", "steps", "page", "size"),
          "On the **Phone scan** page:\n"
          "1. **Measure**: tap **Start AR scan** and tap each roof corner with the camera, or type Length and Width and press **Draw roof from size**.\n"
          "2. **Obstructions**: add water tanks, stair rooms etc. (in the AR scan, or with **+ Add obstruction** and drag them on the plan).\n"
          "3. **Location**: press **Use my location** or type latitude and longitude.\n"
          "4. **Budget (optional)**: type **My budget (₹)** to size the plan to what you can spend; leave it empty to fill the whole roof.\n"
          "5. **Report**: press **Place panels & compute report**.\n"
          "The roof plan is drawn to scale with every edge length, and the report appears below it.",
          ("ar_scan", "obstruction_plan", "location", "budget", "report_read")),
    Topic("ar_scan", "How to use the AR scan",
          ("how to use ar scan", "how does the ar camera work", "how to scan roof corners", "start ar scan steps", "how to use camera"),
          ("ar", "camera", "scan", "corner", "ring", "point", "place", "tap", "close", "shape", "finish", "webxr"),
          "To measure the roof with the AR camera:\n"
          "1. Open the **Phone scan** page on an Android phone in Chrome and tap **Start AR scan**. Allow the camera.\n"
          "2. Point the camera at the floor and move the phone slowly until the **white ring** appears.\n"
          "3. Aim the ring at the first **corner** (where the wall meets the floor), hold still for half a second, tap **Place point**.\n"
          "4. Do the same for every corner, going around the roof in order. After the first corner the floor is **locked**, "
          "so the ring reaches corners up to **5 m** away: stand where you can see them and tap without walking much.\n"
          "5. Tap **Close shape**, add obstructions if any, then tap **Finish**.\n"
          "The roof plan appears with every edge length. **Undo** removes the last point.",
          ("ar_requirements", "ar_accuracy", "ar_obstruction", "ar_messages")),
    Topic("ar_requirements", "Why AR is not available / AR requirements",
          ("ar is not available on this device", "start ar scan button disabled", "ar not working", "which phones support ar",
           "ar needs a secure address", "camera not opening"),
          ("available", "unavailable", "disabled", "support", "arcore", "android", "chrome", "https", "secure", "iphone", "laptop", "requirement"),
          "The AR scan needs:\n"
          "1. An **Android phone with ARCore** (install or update **Google Play Services for AR** from the Play Store).\n"
          "2. **Chrome** on that phone.\n"
          "3. A **secure address**: the site must open over https:// (or localhost).\n"
          "It does not work on laptops or iPhones. If the page says **AR is not available on this device**, use "
          "**Draw roof from size** instead: type the roof length and width.",
          ("ar_scan", "manual_size", "open_on_phone")),
    Topic("ar_accuracy", "Getting accurate AR measurements",
          ("ar measurement is wrong", "ar not accurate", "how to measure accurately", "lengths are wrong", "large roof measurement wrong"),
          ("accurate", "accuracy", "wrong", "error", "precise", "drift", "long", "large", "big", "incorrect", "tips"),
          "Tips for accurate AR measurements:\n"
          "1. Use daylight and point at a textured floor; move the phone **slowly**.\n"
          "2. Hold the ring **still** on each corner for half a second before tapping (shaky taps are refused).\n"
          "3. After the first corner the floor is locked: tap far corners (up to **5 m**) from where you stand instead of walking.\n"
          "4. When you walk, keep the camera looking at the floor 1-2 m ahead, **not straight down**.\n"
          "5. If you see **Tracking drifted** or **tracking jumped**, press **Undo** and redo that corner.\n"
          "6. Check: opposite sides of a rectangular roof should come out about equal. Compare one edge with a tape.",
          ("ar_messages", "ar_scan")),
    Topic("ar_messages", "AR messages: too far, hold still, drifted, edges cross",
          ("what does too far mean", "the ring was moving", "tracking drifted", "tracking jumped", "the edges cross",
           "corners were tapped out of order", "no floor under the crosshair"),
          ("far", "moving", "still", "shaky", "drifted", "jumped", "cross", "order", "crosshair", "message", "warning", "refused"),
          "What the AR messages mean:\n"
          "1. **Too far (x m)**: the corner is more than 5 m away; walk closer for an accurate point.\n"
          "2. **The ring was moving**: hold the phone still on the corner for half a second, then press again.\n"
          "3. **No floor under the crosshair**: move slowly over a well-lit, textured floor until the ring appears.\n"
          "4. **Tracking drifted / jumped**: the phone lost track of its position; press **Undo** and redo that corner.\n"
          "5. **Corners were tapped out of order**: the app put them in order around the shape for you.\n"
          "6. **This point is ... above the first corner**: the ring was on a wall, tank or step, not the floor; Undo it.",
          ("ar_accuracy", "ar_scan")),
    Topic("ar_obstruction", "Marking obstructions in the AR scan",
          ("how to add obstruction in ar", "mark water tank with camera", "obstruction in ar scan not working", "how to scan a tank"),
          ("obstruction", "ar", "camera", "scan", "mark", "base", "points"),
          "To mark an obstruction with the AR camera:\n"
          "1. Scan the roof first and tap **Close shape**.\n"
          "2. Tap **+ Obstruction**.\n"
          "3. Tap at least **3 points where the object meets the floor** (its base, not its top). Any order works; "
          "for a round tank tap 4-6 points around it.\n"
          "4. Tap **Close shape**. Repeat for each obstruction, then **Finish**.\n"
          "If AR is hard around the object, add it on the plan instead with **+ Add obstruction**.",
          ("obstruction_plan", "ar_scan")),
    Topic("obstruction_plan", "Adding obstructions on the plan",
          ("how to add obstructions", "add water tank", "how to add stair room", "how to delete obstruction", "move obstruction"),
          ("obstruction", "obstacle", "tank", "stair", "ac", "heater", "add", "drag", "move", "delete", "remove"),
          "To add an obstruction on the roof plan (Phone scan page):\n"
          "1. Make sure the roof plan is drawn (AR scan or **Draw roof from size**).\n"
          "2. In **Obstructions**, choose the **Type** (Water tank, Stair room, AC unit, Solar heater, Other).\n"
          "3. Type its **Length** and **Width** in metres and press **+ Add obstruction**.\n"
          "4. **Drag** the red box on the plan to where it really is.\n"
          "5. To remove it, select it and press Delete, or use the ✕ in the list.\n"
          "Panels are kept away from every obstruction by the **Obstruction buffer** (0.3 m by default).",
          ("ar_obstruction", "settings")),
    Topic("manual_size", "Typing the roof size (no AR)",
          ("how to type roof size", "draw roof from size", "i dont have ar", "enter length and width"),
          ("type", "manual", "length", "width", "draw", "size", "enter", "rectangle", "without"),
          "Without AR, type the roof size:\n"
          "1. On the **Phone scan** page, under **or type the roof size**, enter **Length (m)** and **Width (m)**.\n"
          "2. Press **Draw roof from size**: a rectangular roof plan appears to scale.\n"
          "3. Add obstructions with **+ Add obstruction** and drag them into place, then compute the report.",
          ("phone_scan", "obstruction_plan")),
    Topic("location", "Setting the location",
          ("how to add location", "how to set location", "use my location not working", "why is location needed", "latitude longitude"),
          ("location", "gps", "latitude", "longitude", "lat", "lon", "place", "city", "address", "where"),
          "To set your location:\n"
          "1. Press **Use my location** and allow location access in the browser, or\n"
          "2. Type **Latitude** and **Longitude** yourself (for example from Google Maps: long-press your house, the numbers appear).\n"
          "The location is used to get the real **sunlight (irradiance)** for your site from NASA POWER, so the yearly units and "
          "savings are right for your area. It also sorts installers by distance. Without a location a general placeholder "
          "irradiance is used.",
          ("report_read", "installers")),
    Topic("settings", "Layout & cost settings",
          ("what are layout settings", "what is edge setback", "change panel size", "change tariff", "obstruction buffer meaning"),
          ("setting", "settings", "setback", "buffer", "gap", "edge", "tariff", "cost", "change", "panel", "power", "layout"),
          "Open **Layout & cost settings** to change:\n"
          "1. **Edge setback**: gap kept free along the roof edges (default **0.3 m**) for safety, walking and cleaning.\n"
          "2. **Obstruction buffer**: gap around tanks and stair rooms (default 0.3 m).\n"
          "3. **Panel length / width / power**: the standard panel (default 1.70 × 1.00 m, 350 Wp).\n"
          "4. **Fill leftover space with small panels** and the small panel size (default 1.00 × 0.67 m, 100 Wp).\n"
          "5. **Tariff (₹/kWh)** and **Installed cost (₹/kWp)**: leave empty to use the defaults.\n"
          "Compute the report again after changing them.",
          ("panel_sizes", "no_fit")),
    Topic("panel_sizes", "Panel sizes and small panels",
          ("what panel size is used", "small panels", "minimum panel size", "why are some panels green", "mixed panel sizes"),
          ("panel", "size", "small", "minimum", "teal", "green", "blue", "module", "watt", "wp", "dimension", "mixed"),
          "Panel sizes used in the layout:\n"
          "1. **Standard panel** (blue): 1.70 × 1.00 m, 350 Wp, a common residential 60-cell module.\n"
          "2. **Small panel** (teal): 1.00 × 0.67 m, 100 Wp; fills corners and strips the standard panels leave.\n"
          "The report's **Panels** table lists each size, its power and count, the total, and the **minimum panel size**. "
          "Small panels work at a different voltage, so an installer wires them on a separate string or uses microinverters. "
          "You can change both sizes or switch small panels off in **Layout & cost settings**.",
          ("settings", "no_fit")),
    Topic("no_fit", "Why no panel fits / 0 panels",
          ("why are no panels fitting", "0 panels", "no panel fits", "area is too small", "solar not computing"),
          ("zero", "none", "fit", "fits", "small", "too", "nothing", "computing", "empty", "why"),
          "If the report shows **0 panels**, the free area is smaller than one panel plus the edge gap.\n"
          "1. A 1.00 × 0.67 m small panel with the 0.3 m edge gap needs about **1.6 × 1.3 m** of clear roof; "
          "a standard 1.70 × 1.00 m panel needs about **2.3 × 1.6 m**.\n"
          "2. The report says exactly which **Edge setback** would make a panel fit; lower it in **Layout & cost settings**.\n"
          "3. Check you measured the **whole roof**, and that obstructions are not covering it.",
          ("settings", "panel_sizes")),
    Topic("report_read", "Understanding the report",
          ("what does the report mean", "what is kwp", "explain the report", "what is payback", "how are savings calculated"),
          ("report", "kwp", "kwh", "savings", "payback", "units", "generation", "co2", "result", "meaning", "explain", "calculated"),
          "The report shows:\n"
          "1. **Panels that fit** and **System size (kWp)**: total panel power.\n"
          "2. **kWh per year**: yearly units, from your site's sunlight (NASA POWER) and a 0.75 performance ratio.\n"
          "3. **₹ saved per year**: units × electricity tariff.\n"
          "4. **Cost after subsidy**: system cost (₹50,000 per kWp benchmark) minus the PM Surya Ghar subsidy.\n"
          "5. **Payback**: cost after subsidy ÷ yearly savings.\n"
          "6. **CO₂ avoided** per year.\n"
          "If you set a budget, the green **Sized to your budget** note says how the plan was reduced to fit it. "
          "Every value and its source is under **Assumptions and sources**. It is an estimate: get written quotes from installers.",
          ("subsidy", "budget", "download", "installers")),
    Topic("subsidy", "PM Surya Ghar subsidy",
          ("how much subsidy", "what is pm surya ghar", "subsidy calculation"),
          ("subsidy", "surya", "ghar", "government", "scheme", "pmsg"),
          "The report applies the **PM Surya Ghar** rooftop subsidy: **₹30,000 per kW** for the first 2 kW, "
          "**₹18,000** for the 3rd kW, capped at **₹78,000** (for 3 kW and above). "
          "Check eligibility and apply on pmsuryaghar.gov.in through an empanelled vendor.",
          ("report_read", "installers")),
    Topic("download", "Downloading or printing the report",
          ("how to download report", "save as pdf", "print the report", "share report", "download plan image"),
          ("download", "pdf", "print", "save", "share", "file", "export", "image", "plan"),
          "After computing, at the top of **Your solar report**:\n"
          "1. **⬇ Download report** saves one file with the roof plan picture, the panels table, energy, money and all assumptions. "
          "It opens on any phone or computer.\n"
          "2. **🖨 Print / Save as PDF** opens the report and the print dialog: choose **Save as PDF**.\n"
          "**Save plan image** (under the plan) saves just the roof plan picture.",
          ("history", "report_read")),
    Topic("history", "Recent reports (history)",
          ("where are my old reports", "previous searches", "history", "last reports", "how to see old results"),
          ("history", "recent", "previous", "old", "last", "past", "saved", "earlier"),
          "Your **last 4 reports** are kept under **Recent reports** at the bottom of the Phone scan and Image pages. "
          "Each shows a small plan picture, panels, kWp, roof area and cost, with **View**, **⬇ Download** and **✕** (remove). "
          "**Clear** removes them all. They are saved only in this browser on this device.",
          ("download", "privacy")),
    Topic("budget", "Planning for your budget",
          ("i have only 1 lakh budget", "plan for my budget", "how to set budget", "reduce cost to fit my budget", "cheaper plan",
           "what is room for more", "what are the dashed outlines", "can i add more panels later",
           "how much solar can i get for my money", "how to remove the budget", "sized to your budget",
           "what does budget covers mean"),
          ("budget", "afford", "lakh", "lac", "invest", "investment", "spend", "cheaper", "rupees", "limit", "money",
           "dashed", "outline", "later", "room", "more", "remove", "sized"),
          "SolarScope can plan the solar for **your budget**:\n"
          "1. In **Budget (optional)**, type **My budget (₹)**, for example 100000 for 1 lakh. Or just tell me, "
          "e.g. \"I have only 1 lakh\": I'll fill it in and recompute for you.\n"
          "2. Choose **Budget covers**: **Cost after subsidy** (what you finally pay) or **Full upfront cost** "
          "(under PM Surya Ghar you usually pay the full cost first; the subsidy reaches your bank later).\n"
          "3. Press **Place panels & compute report** (or **Compute solar report**).\n"
          "You get the **biggest system you can afford** on your roof, and the whole report is recomputed: panels, kWp, "
          "units, savings, subsidy and payback. The green **Sized to your budget** note shows the cost, what is left and "
          "what the full roof would cost. On the plan, **dashed outlines** (\"Room for more\") show where panels can be "
          "added later. As a guide, ₹1 lakh after subsidy buys up to about 3.5 kWp. "
          "To remove the budget, clear **My budget** and compute again: the whole roof is filled.",
          ("report_read", "subsidy")),
    Topic("image_page", "Using the Image page",
          ("how to use image page", "upload roof photo", "drone image", "how to analyse an image",
           "too many panels from photo", "image gives huge number of panels"),
          ("image", "photo", "upload", "drone", "aerial", "picture", "sample", "satellite", "huge", "imaginary"),
          "On the **Image** page:\n"
          "1. **Upload image**: a photo of your roof (phone, drone or satellite), or tap a sample.\n"
          "2. Mark the roof: **Detect roof & obstructions** (if available) or paint it with the **Roof** brush; paint tanks "
          "and stair rooms with **Obstruction**. **Pick my roof** keeps just your building.\n"
          "3. **Roof size**: type the roof's real **Roof length (m)** and **Roof width (m)** (measure with a tape or the Phone "
          "scan). The photo alone cannot show how big the roof is.\n"
          "4. Set the location (and a budget if you like), then press **Compute solar report**.\n"
          "The marked roof is redrawn to your size (also for photos taken at an angle), panels are laid out on it like a "
          "phone scan, and you get a **to-scale roof plan** plus the panels drawn on your photo. Type the real size of each "
          "numbered obstruction under **Obstruction sizes** (Rectangle or 4 different sides) for a more exact plan. "
          "Use a photo that shows **all 4 roof corners**: if the roof runs out of the picture, the app warns you, because "
          "the photo edge is then not the real roof edge. Panels are placed in straight, aligned rows inside the roof size you typed.",
          ("scale", "brush", "location")),
    Topic("scale", "Roof size and image scale",
          ("how to set scale", "metres per pixel", "calibrate", "draw a known length", "measure a wall with ar",
           "roof length and width for photo", "obstruction size in image", "why do i need to type roof size",
           "roof with 4 different sides", "my roof is not a rectangle", "what is the diagonal",
           "my water tank is not a rectangle", "obstruction with 4 sides", "obstruction size on the photo"),
          ("scale", "metre", "pixel", "calibrate", "known", "gsd", "resolution", "wall", "length", "width", "size",
           "sides", "side", "diagonal", "rectangle", "shape", "irregular"),
          "The app must know how big the roof really is:\n"
          "1. **Phone photos** (default): in step 2 **Roof size** choose **Rectangle** and type **Roof length (m)** and "
          "**Roof width (m)**, or choose **4 different sides** and type the **Top**, **Right**, **Bottom** and **Left** side "
          "as seen in the photo (plus, optionally, the **diagonal** from the top-left to the bottom-right corner, which makes "
          "the shape exact). The roof's corners in the photo are mapped onto that real shape, which also corrects a photo "
          "taken at an angle; the sides are then labelled on the photo so you can check them. Every obstruction you paint "
          "gets a **number** on the photo and its own card under **Obstruction sizes**: choose **Rectangle** (length and "
          "width) or **4 different sides** (top, right, bottom, left as seen in the photo) and type its real size; leave "
          "it empty to use the painted shape.\n"
          "2. **Drone or satellite images with a known scale**: open **Drone or satellite image**, tick **Use the image scale "
          "instead of the roof size**, and type **Metres per pixel**, or press **Calibrate: draw a known length** "
          "(draw over something you measured, type its **Real length**, **Apply**), or use **Measure a wall with AR**.",
          ("image_page",)),
    Topic("brush", "Correcting the roof with the brush",
          ("how to use brush", "fix the roof mask", "pick my roof", "erase", "zoom image", "undo brush"),
          ("brush", "paint", "mask", "erase", "pick", "correct", "fix", "zoom", "pan", "undo", "overlay"),
          "To correct the detected roof on the Image page:\n"
          "1. Choose **Roof** (green), **Obstruction** (red) or **Erase**, set the **Brush size**, and paint on the image.\n"
          "2. **Pick my roof**: drag a box around your building to analyse only that roof (**Whole image** undoes it).\n"
          "3. **Undo** reverts the last stroke. Zoom with **+ / −**, **Fit**, scroll or pinch; move with **Pan** (or hold Space).\n"
          "4. **Show overlay** hides or shows the colours.",
          ("image_page", "ai_model")),
    Topic("ai_model", "AI detection / model offline",
          ("detect button not working", "model offline", "how does ai detection work"),
          ("ai", "model", "detect", "detection", "offline", "automatic", "segmentation"),
          "**Detect roof & obstructions** uses an AI model (U-Net) trained on Indian rooftop drone images. "
          "If the top bar says **Model offline — paint by hand**, the model file is not installed on this server: "
          "paint the roof and obstructions with the brush instead; everything else works the same.",
          ("brush",)),
    Topic("installers", "Finding solar installers",
          ("how to find installers", "find solar vendors", "contact installer", "installer list shows other state", "vendors near me"),
          ("installer", "installers", "vendor", "vendors", "company", "dealer", "contact", "near", "call", "whatsapp", "email", "nearby"),
          "After the report, press **📍 Find solar installers near me**:\n"
          "1. Installers are sorted **nearest first** using your report's location, or press **Use my current location**.\n"
          "2. Filter by **State** and **City / area**, distance (25-250 km) or the search box.\n"
          "3. **Only installers that handle N kWp** keeps those whose system range fits yours; untick it to see all.\n"
          "4. Contact with **Call**, **WhatsApp**, **Email**, **Directions** or **Website**.\n"
          "Karnataka entries marked **DEMO DATA** (Bengaluru, Mysuru, Hassan, Mandya) are synthetic examples for this project, not real companies.",
          ("demo_vendors", "location")),
    Topic("demo_vendors", "Karnataka demo vendors",
          ("are karnataka vendors real", "demo data vendors", "bengaluru installers", "mysuru hassan mandya vendors"),
          ("karnataka", "bengaluru", "bangalore", "mysuru", "mysore", "hassan", "mandya", "demo", "synthetic", "fake", "real"),
          "The Karnataka installers in **Bengaluru, Mysuru, Hassan and Mandya** are **synthetic demo data** for this project: "
          "each card says **DEMO DATA · not a real company**. They have no phone numbers and only example.com emails. "
          "Installers from Madhya Pradesh and Puducherry come from official government vendor lists. "
          "For real Karnataka vendors check pmsuryaghar.gov.in or BESCOM / CESC.",
          ("installers",)),
    Topic("open_on_phone", "Opening the site on a phone",
          ("how to open on phone", "phone link not working", "link expired", "trycloudflare link"),
          ("link", "url", "open", "phone", "mobile", "tunnel", "cloudflare", "expired", "working"),
          "To use the site on your phone it needs an **https://** address (for the camera). On the computer running "
          "SolarScope, start the phone link (start-ar-link.bat) and open the **trycloudflare.com** link it shows, "
          "with **/scan.html** at the end. The link works only while that window is open, and changes each time it is started.",
          ("ar_requirements",)),
    Topic("theme", "Dark / light mode",
          ("how to change theme", "dark mode", "light mode", "text not visible"),
          ("theme", "dark", "light", "mode", "colour", "color", "contrast"),
          "Use the **sun / moon button** at the top right to switch between light and dark mode. "
          "Your choice is remembered; without a choice the site follows your phone or computer setting.",
          ()),
    Topic("privacy", "Privacy and data",
          ("is my data saved", "privacy", "where is my data stored"),
          ("privacy", "data", "stored", "store", "safe", "personal", "server"),
          "Your roof images and plans are only sent to this app's own server to compute the report; nothing is shared. "
          "Recent reports are stored **only in your browser**. Your location is rounded to about 1 km when sorting installers "
          "and is not stored.",
          ("history",)),
    Topic("accuracy_estimate", "How accurate is the estimate",
          ("is this estimate accurate", "can i trust the numbers", "why are values placeholders"),
          ("estimate", "trust", "placeholder", "verified", "assumption", "accurate", "real"),
          "The report is a **planning estimate**. Panel layout depends on how accurately the roof was measured; energy uses "
          "NASA POWER sunlight for your location; money uses benchmark costs and tariffs. Inputs not yet verified against "
          "official sources are marked in **Assumptions and sources**. Always confirm with a site survey and written quotes.",
          ("report_read",)),
)

SMALL_TALK = {
    "greeting": ({"hi", "hello", "hey", "namaste", "hii", "helo"},
                 "Hello! I'm the SolarScope helper. Ask me how to use the AR scan, add obstructions, set your location, "
                 "read the report or find installers."),
    "thanks": ({"thanks", "thank", "thx", "ok", "okay", "great", "cool"},
               "You're welcome! Ask me anything else about SolarScope."),
}

# Words people use for the same thing as the knowledge base.
SYNONYMS = {
    "camera": "ar", "augmented": "ar", "corners": "corner", "obstacle": "obstruction", "obstacles": "obstruction",
    "obstructions": "obstruction", "tanks": "tank", "watertank": "tank", "staircase": "stair", "stairs": "stair",
    "gps": "location", "coordinates": "location", "pdf": "pdf", "vendor": "installer", "vendors": "installer",
    "installers": "installer", "dealer": "installer", "dealers": "installer", "companies": "installer",
    "module": "panel", "modules": "panel", "panels": "panel", "cell": "panel", "cells": "panel", "price": "cost",
    "money": "cost", "rate": "tariff", "bill": "tariff", "previous": "history", "past": "history", "recent": "history",
    "bangalore": "bengaluru", "mysore": "mysuru", "photo": "image", "picture": "image", "pic": "image",
    "wrong": "accurate", "incorrect": "accurate", "inaccurate": "accurate", "accuracy": "accurate",
    "measurement": "measure", "measuring": "measure", "measured": "measure", "scanning": "scan", "scanned": "scan",
}

STOP = {"a", "an", "the", "is", "are", "to", "do", "i", "my", "me", "how", "can", "what", "of", "in", "on", "for", "it",
        "this", "that", "and", "or", "with", "be", "you", "your", "does", "should", "we", "use", "using", "add", "get",
        "where", "when", "which", "there", "please", "tell", "about", "show", "explain", "need", "want", "not", "why"}


def _stem(w: str) -> str:
    for suf in ("ing", "ed", "es", "s"):
        if len(w) > 4 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def _words(text: str) -> list[str]:
    out = []
    for w in re.findall(r"[a-z0-9₹]+", text.lower()):
        w = SYNONYMS.get(w, w)
        out.append(_stem(w))
    return out


def _terms(text: str) -> list[str]:
    return [w for w in _words(text) if w not in STOP and len(w) > 1]


# Per-topic weighted term bags, document frequencies, and the vocabulary for typo correction.
_BAGS: dict[str, dict[str, float]] = {}
for _t in TOPICS:
    bag: dict[str, float] = {}
    for text, weight in ((" ".join(_t.keywords), 3.0), (" ".join(_t.questions), 2.0), (_t.title, 2.0), (_t.answer, 0.5)):
        for w in _terms(text):
            bag[w] = max(bag.get(w, 0.0), weight)
    _BAGS[_t.id] = bag
_DF: dict[str, int] = {}
for _bag in _BAGS.values():
    for _w in _bag:
        _DF[_w] = _DF.get(_w, 0) + 1
_VOCAB = sorted(_DF)
BY_ID = {t.id: t for t in TOPICS}


def _correct(w: str) -> str | None:
    """Known word for a typo (camrea -> camera handled via synonyms after correction), or None."""
    if w in _DF:
        return w
    if len(w) < 4:
        return None
    m = difflib.get_close_matches(w, _VOCAB, n=1, cutoff=0.8)
    return m[0] if m else None


def search(question: str, k: int = 3) -> list[tuple[Topic, float]]:
    """Topics ranked by relevance to the question (best first), with scores."""
    terms = [c for w in _terms(question) if (c := _correct(w))]
    if not terms:
        return []
    n = len(TOPICS)
    scores = []
    for t in TOPICS:
        bag = _BAGS[t.id]
        s = sum(bag[w] * math.log(1 + n / _DF[w]) for w in set(terms) if w in bag)
        # Whole example question contained in the user's question: strong signal.
        q = " ".join(_words(question))
        s += sum(3.0 for ex in t.questions if " ".join(_words(ex)) in q)
        if s > 0:
            scores.append((t, s))
    scores.sort(key=lambda x: -x[1])
    return scores[:k]


MIN_SCORE = 2.5


def answer(question: str) -> dict:
    """Offline answer: {"answer", "topic", "suggestions"} (suggestions are topic titles to ask next)."""
    words = set(re.findall(r"[a-z]+", question.lower()))
    for key, (triggers, reply) in SMALL_TALK.items():
        if words and words <= triggers | STOP:
            return {"answer": reply, "topic": key, "suggestions": [BY_ID[i].title for i in ("ar_scan", "obstruction_plan", "location")]}
    hits = search(question)
    if not hits or hits[0][1] < MIN_SCORE:
        return {
            "answer": "I'm not sure about that one. I can help with using SolarScope: the AR scan, typing the roof size, "
                      "obstructions, location, settings, panel sizes, the report, downloads, history and installers. "
                      "Try one of the suggestions below.",
            "topic": None,
            "suggestions": [BY_ID[i].title for i in ("ar_scan", "obstruction_plan", "location", "report_read")],
        }
    best = hits[0][0]
    related = [BY_ID[i].title for i in best.related if i in BY_ID]
    for t, s in hits[1:]:
        if t.title not in related and t.id != best.id and s >= hits[0][1] * 0.6:
            related.append(t.title)
    return {"answer": best.answer, "topic": best.id, "suggestions": related[:4]}


def guide_text() -> str:
    """The whole knowledge base as text, for grounding the AI answers."""
    return "\n\n".join(f"## {t.title}\n{t.answer}" for t in TOPICS)


def starter_questions(page: str | None = None) -> list[str]:
    """Quick-question chips for the chat, tuned to the page the user is on."""
    common = ["How do I find installers?", "How do I download the report?"]
    per_page = {
        "scan": ["How do I use the AR scan?", "How do I add obstructions?", "How do I plan for my budget?",
                 "How do I set my location?", "Why are no panels fitting?"],
        "image": ["How do I set the image scale?", "How do I use the brush?", "How do I plan for my budget?",
                  "How do I set my location?", "What does the report mean?"],
        "installers": ["Are the Karnataka vendors real?", "How do I find installers near me?", "What is the PM Surya Ghar subsidy?"],
    }
    return per_page.get(page or "", ["What does SolarScope do?", "How do I use the AR scan?", "How do I add obstructions?"]) + common

# ---------- budget requests ("I have only 1 lakh") ----------

# Number words count only with a unit ("one lakh"); "i" is the common typo for 1 in "i lakh".
_NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
              "ten": 10, "half": 0.5, "i": 1}
_UNITS = {"lakh": 1e5, "lakhs": 1e5, "lac": 1e5, "lacs": 1e5, "l": 1e5, "crore": 1e7, "crores": 1e7, "cr": 1e7,
          "k": 1e3, "thousand": 1e3}
_AMOUNT = re.compile(
    r"(?:₹|rs\.?|inr)?\s*\b(\d[\d,]*(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|half|i(?=\s*la))\s*"
    r"(lakhs?|lacs?|crores?|cr|thousand|k|l)?\b(?!\s*(?:m|kw|kwp|panels?|years?|%|m2|sq))")
_BUDGET_WORDS = {"budget", "afford", "lakh", "lakhs", "lac", "invest", "investment", "spend", "rupees", "rs", "inr", "₹",
                 "cost", "money", "only", "have", "pay"}


def budget_request(question: str) -> dict | None:
    """{"amount": INR, "basis": "net"|"gross"} if the question states a budget (e.g. "I have only 1 lakh"), else None."""
    q = question.lower().replace("₹", " ₹")
    words = set(re.findall(r"[a-z₹]+", q))
    if not words & _BUDGET_WORDS:
        return None
    found = []  # (position, amount)
    for m in _AMOUNT.finditer(q):
        raw, unit = m.group(1), m.group(2)
        value = _NUM_WORDS.get(raw) if raw in _NUM_WORDS else float(raw.replace(",", ""))
        if unit:
            value *= _UNITS[unit]
        elif raw in _NUM_WORDS or value < 1000:
            continue  # a bare small number ("2 panels", "3 years") is not a budget
        if 1000 <= value <= 1e9:
            found.append((m.start(), value))
    if not found:
        return None
    only = q.find("only")
    after_only = [a for pos, a in found if only >= 0 and pos > only]
    amount = after_only[0] if after_only else found[-1][1]
    gross = any(w in q for w in ("upfront", "up front", "full cost", "full price", "without subsidy", "before subsidy", "total cost"))
    return {"amount": round(amount), "basis": "gross" if gross else "net"}


def inr(v: float) -> str:
    """Indian digit grouping: 150000 -> 1,50,000."""
    s = str(int(round(v)))
    if len(s) <= 3:
        return s
    head, tail = s[:-3], s[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    return ",".join(([head] if head else []) + groups + [tail])
