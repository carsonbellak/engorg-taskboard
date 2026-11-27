/* =====================================================================
 * PORTFOLIO CONTENT. This is the only file you need to edit.
 *
 * Served at  https://assistant-taskboard.web.app/portfolio
 * Files go in pwa/portfolio/assets/ and are referenced as
 *   '/portfolio/assets/<folder>/<file>'   (always start with /portfolio/)
 *
 *   assets/images/  photos, renders, screenshots (.jpg .png .webp .gif)
 *   assets/models/  3D models: .stl .glb .gltf .obj .step .stp
 *                   (STL/GLB load instantly; STEP pulls a ~7 MB converter the
 *                    first time, so export GLB/STL for big assemblies)
 *   assets/pcb/     KiCad files: .kicad_pcb .kicad_sch (rendered live, zoomable)
 *   assets/video/   .mp4 .webm
 *   assets/resume.pdf   the Resume button hides itself until this file exists
 *
 * A project's `media` list is its gallery. Each item is one of:
 *   { type: 'image', src, caption }
 *   { type: 'model', src, caption, color: '#hex', zUp: true|false }
 *       zUp defaults to true for STL/STEP (CAD exports) and false for GLB/OBJ.
 *   { type: 'pcb',   src, caption }              one KiCad file, or
 *   { type: 'pcb',   files: [pcb, sch], caption } board + schematic together
 *   { type: 'video', src, caption, poster }
 *   Any item can have `label: 'Short name'` for its gallery tab (default: 3D / PCB / Video).
 *   { type: 'embed', src, caption }              any iframe-able viewer, e.g. an
 *       Onshape / Fusion 360 / Sketchfab / YouTube embed link
 *   An item with no src shows its caption as a "coming soon" placeholder.
 *
 * `notice` (optional) shows a highlighted note on the project, used here to say
 * how work designs were altered before publishing.
 *
 * WORK DESIGNS: never put a real work .kicad_pcb / STEP here. PCBs go through the
 * sanitizer (real outline + placement, random routing/nets/values) and models are
 * low-resolution meshes. Anything marked TODO is a placeholder.
 * ===================================================================== */

window.PORTFOLIO = {
  name: 'Carson Bellak',
  role: 'Mechanical Engineering · Purdue \'28',
  tagline: '',                                         // optional one-liner under your name; '' shows none
  location: '',                                         // TODO (optional)
  status: '',                                          // (unused in the current layout)
  photo: '',                                            // TODO (optional) '/portfolio/assets/images/me.jpg'
  resume: '/portfolio/assets/resume.pdf',
  assetVersion: '2026-11-27f',
  // Biggest projects first (also orders the rotating showcase)
  projectOrder: ['power-supply', 'optical-probe', 'spacer', 'socket-plate', 'wifi-checker', 'engorg', 'calibration'],

  contact: {
    email: 'bellakcarson@gmail.com',
    phone: '(856) 394-0698',
    linkedin: 'https://www.linkedin.com/in/carson-bellak-803927353/',
    github: '',
  },

  // The interactive model in the header.
  // The rotating tile in the header: cycles through these models (spins each, then moves on).
  // `project` links the label to that project's section. Add an entry per model you make.
  showcase: [
    { model: '/portfolio/assets/models/optical-probe-mounted.glb', label: 'Optical probe shell', project: 'optical-probe', zUp: false },
    { model: '/portfolio/assets/models/power-supply-mounted.glb', label: '3-phase precision power supply', project: 'power-supply', zUp: false },
    { model: '/portfolio/assets/models/socket-plate-mounted.glb', label: 'Meter socket plate', project: 'socket-plate', zUp: false, view: [-1, 0.6, -1.3] },
    { model: '/portfolio/assets/models/spacer-shelled-mounted.glb', label: 'Injection-molded spacer', project: 'spacer', zUp: false },
    { model: '/portfolio/assets/models/calibration-cube-mounted.glb', label: '3D-printer calibration cube', project: 'calibration', zUp: false, view: [0.75, 0.55, -1.3] },
    { model: '/portfolio/assets/models/power-supply-exploded.glb', label: 'Power supply, exploded', project: 'power-supply', zUp: false },
  ],

  about: [
    'I\'m a Mechanical Engineering student at Purdue University, with a minor in mathematics, graduating in 2028.',
    'I spent a full year as an R&D and testing co-op at Landis+Gyr, in the lab that qualifies the company\'s electricity meters against ANSI specifications. I ran hundreds of hardware validation tests there, and owned design projects from first sketch to production: an injection-molded spacer that cleared a failed customer qualification and shipped at 50,000 units, a ground-up 3-phase precision power supply, and the optical communication probe the company sells to its customers.',
    'My work tends to cross disciplines. I have hundreds of hours in PTC Creo designing for injection molding and 3D printing, more than a hundred in KiCad on high-power and high-frequency boards, and I\'m IPC J-STD-001 certified for soldering and reflow. I also write the software around the hardware: test utilities that automate manual lab work, and the app this page is hosted on.',
    'Off the clock I play golf, currently at a 7.5 handicap.',
  ],

  skills: [
    { group: 'Mechanical & CAD', items: ['PTC Creo', 'DFM for injection molding', 'Engineering drawings', 'Machining', 'Tight-tolerance hand fabrication'] },
    { group: '3D printing',      items: ['PC-CF', 'PA6-GF', 'PP-CF', 'Production fixtures', 'Rapid prototyping'] },
    { group: 'Electrical',       items: ['KiCad', 'High-power & high-frequency PCBs', 'LTspice', 'SMD soldering & reflow', 'IPC J-STD-001', 'Electrical wiring'] },
    { group: 'Test & validation', items: ['ANSI meter qualification', 'Hardware validation testing', 'Root-cause troubleshooting', 'Oscilloscope', 'I²C'] },
    { group: 'Software',         items: ['Python', 'JavaScript / Node.js', 'Electron', 'Kotlin / Android', 'Git'] },
  ],

  projects: [
    {
      id: 'optical-probe',
      short: 'Optical probe',
      title: 'Optical probe redesign',
      date: '2026 · In production',
      org: 'Landis+Gyr',
      summary: 'The optical communication probe Landis+Gyr sells to its customers, redesigned from the ground up: a high-frequency board that reads and transmits meter pulses to 1 MHz, in a 3D-printed PC-CF housing rated for 85 °C at 85% humidity.',
      tags: ['Electrical', 'PCB', 'KiCad', '3D printing'],
      notice: 'The board shown here is a portfolio copy: its outline, part placement and package sizes are real, but the routing, net names, component values and reference designators are randomized, and the 3D board is reduced to plain blocks, to protect my employer\'s design.',
      links: [],
      body: [
        'Meters expose a standard infrared optical port (ANSI C12.18) for reading and configuration. This project was a ground-up redesign of the USB probe that clips onto that port, done on a small team through four board revisions, covering both the electronics and the enclosure.',
        'The finished design was validated against the rating it has to carry in the field: pulse read and transmit to 1 MHz, and survival under 85/85 conditions, 85 °C at 85% relative humidity. Once it passed, it went into production as the probe the company supplies to its customers.',
      ],
      sections: [
        {
          title: 'Mechanical design',
          body: [
            'I designed the enclosure in PTC Creo: a two-piece shell that splits down the middle around the board, and a separate head that holds the LEDs square to the meter\'s optical port.',
            'The shell is printed in carbon-fiber polycarbonate (PC-CF), chosen to hold its shape through the 85 °C / 85% humidity rating. The cable exits through strain reliefs cast in silicone from a mold I also designed.',
          ],
          media: [
            { type: 'model', label: 'Shell', src: '/portfolio/assets/models/optical-probe-mounted.glb', caption: 'Printed shell with the LED head', zUp: false },
            { type: 'model', label: 'Exploded', src: '/portfolio/assets/models/optical-probe-exploded.glb', caption: 'Shell halves split apart around the LED head', zUp: false },
          ],
        },
        {
          title: 'Electrical design',
          body: [
            'The board pairs a USB-to-UART bridge with an infrared LED transmitter and a photodiode receiver feeding a transimpedance amplifier: USB on one end, the optical head on the other, on a compact multilayer board designed in KiCad.',
            'Most of the engineering was in the receive path: getting clean, fast edges at high data rates while still picking up the meter\'s own pulse output. The receiver\'s gain trades directly against its speed, so I characterized that trade-off on the bench and tuned the front end to cover both.',
          ],
          media: [
            { type: 'model', label: '3D board', protect: true, src: '/portfolio/assets/models/optical-probe-board-mounted.glb', caption: 'Board in 3D: parts reduced to plain blocks, routing randomized', zUp: false, view: [0.6, 1.1, 1.0] },
            { type: 'pcb', label: 'Layout', protect: true, src: '/portfolio/assets/pcb/optical-probe.kicad_pcb', caption: 'Layout view (scroll to zoom, click a part). Routing, values and designators are randomized.' },
          ],
        },
      ],
    },
    {
      id: 'power-supply',
      short: 'Power supply',
      title: '3-phase precision power supply',
      date: '2025 to 2026',
      org: 'Landis+Gyr',
      summary: 'A 4500 VA, 3-phase precision source built from the ground up in a server rack: 600 V and 600 A with ±0.001 V and ±0.001 A precision, for powering meters under test.',
      tags: ['Mechanical', 'Electrical', 'CAD', 'Creo'],
      notice: 'Part numbers, the BOM and the source CAD are not published.',
      links: [],
      body: [
        'A full ground-up build, from mechanical CAD to electrical assembly: a 4500 VA, 3-phase supply that delivers up to 600 V and 600 A with ±0.001 V and ±0.001 A precision, packaged in a server rack so it can sit in the lab alongside the meters it powers.',
        'I built the full top-level assembly in Creo Parametric: rack-mount drawers, filtered forced-air cooling, the control and range-switching electronics, and the socket plate that holds meters under test.',
        'The socket plate was my own part. Integrating it meant fitting off-the-shelf rack hardware, fasteners and boards into one assembly that could be purchased against a BOM and built.',
      ],
      media: [
        { type: 'model', label: 'Mounted', src: '/portfolio/assets/models/power-supply-mounted.glb', caption: 'Assembled: every rack unit mounted', zUp: false },
        { type: 'model', label: 'Panels off', src: '/portfolio/assets/models/power-supply-panels-off.glb', caption: 'Side and rear panels removed to show the rack units inside', zUp: false },
        { type: 'model', label: 'Exploded', src: '/portfolio/assets/models/power-supply-exploded.glb', caption: 'Exploded: panels pushed out, units pulled from the rack', zUp: false },
      ],
    },
    {
      id: 'socket-plate',
      short: 'Socket plate',
      title: 'Meter socket plate',
      date: '2026 · Part of the 3-phase power supply',
      org: 'Landis+Gyr',
      summary: 'The plate inside the power supply rack that holds two meter sockets under test, with the socket routing board and relays behind it. Designed in Creo.',
      tags: ['Mechanical', 'CAD', 'Creo'],
      links: [],
      body: [
        'Meters under test plug into two standard meter sockets. I designed the front and back plates that carry them, spaced on standoffs so the socket routing board and its relays sit between the plates and the wiring stays short.',
        'The plate is a 19-inch rack panel with cutouts for the two sockets and a path for the wiring, painted to match the rack.',
      ],
      media: [
        { type: 'model', label: 'Assembled', src: '/portfolio/assets/models/socket-plate-mounted.glb', caption: 'Socket plate assembly: two meter sockets, routing board and relays', zUp: false, view: [-1, 0.6, -1.3] },
        { type: 'model', label: 'Exploded', src: '/portfolio/assets/models/socket-plate-exploded.glb', caption: 'Exploded through the stack: front plate, sockets, routing board, back plate', zUp: false, view: [-1.6, 0.5, -0.9] },
      ],
    },
    {
      id: 'calibration',
      short: 'Printer calibration',
      title: '3D-printer calibration set',
      date: '2026 · Personal project',
      summary: 'Test parts I modelled in Creo to tune my Creality K1C: dimension cubes, a hollow cube for wall and bridging checks, and a 25 mm test cube.',
      tags: ['3D printing', 'CAD', 'Creo'],
      links: [],
      body: [
        'I keep a small set of calibration parts for my printer: 10, 25 and 50 mm cubes to check dimensional accuracy in each axis, a 50 mm cube hollowed to 25 mm for wall thickness and bridging, and the 25 mm test cube shown here.',
        'Measuring them after a profile change tells me straight away whether flow, shrinkage or the slicer settings have drifted, before printing a real part.',
      ],
      media: [
        { type: 'model', label: 'Test cube', src: '/portfolio/assets/models/calibration-cube-mounted.glb', caption: '25 mm calibration test cube (drag to orbit)', zUp: false, view: [0.75, 0.55, -1.3] },
      ],
    },
    {
      id: 'spacer',
      short: 'Molded spacer',
      title: 'Injection-molded spacer',
      date: '2026 · 50,000 units in production',
      org: 'Landis+Gyr',
      summary: 'A polycarbonate spacer that fixed a failed customer qualification and unblocked a commitment to one of the company\'s largest customers, then went to production at 50,000 units.',
      tags: ['Mechanical', 'CAD', 'Creo', 'Injection molding', 'Validation testing'],
      links: [],
      body: [
        'A meter failed a customer-specific qualification test, and that failure stalled a commitment to one of Landis+Gyr\'s largest customers. I traced it to its root cause and designed a polycarbonate spacer in PTC Creo that fixed it with no change to the existing meter.',
        'From there I drove it through validation: re-running the qualification testing the meter had failed, and iterating the design until it passed. The part was designed for injection molding from the start, and it went to production at 50,000 units.',
      ],
      media: [
        { type: 'model', label: 'Production', src: '/portfolio/assets/models/spacer-shelled-mounted.glb', caption: 'The injection-molded design', zUp: false },
        { type: 'model', label: 'Prototype', src: '/portfolio/assets/models/spacer-solid-mounted.glb', caption: 'Earlier solid iteration', zUp: false },
        { type: 'model', label: 'Variant', src: '/portfolio/assets/models/spacer-slotted-mounted.glb', caption: 'Slotted variant explored during iteration', zUp: false },
      ],
    },
    {
      id: 'wifi-checker',
      short: 'Wifi Checker',
      title: 'Wifi Checker: fleet test tool',
      date: '2025 to 2026',
      org: 'Landis+Gyr',
      summary: 'A desktop tool that finds every meter under test on the lab network, checks its Wi-Fi connectivity, applies configuration changes in bulk and writes Excel reports, including unattended scheduled runs.',
      tags: ['Software', 'Python', 'Test automation'],
      links: [],
      body: [
        'Testing meter Wi-Fi meant checking dozens of devices by hand. I took an earlier internal script by two colleagues and rebuilt it into a full PyQt5 application of about 3,000 lines.',
        'It reads the list of meters under test, locates each one on the lab network in parallel, and checks its connection on a thread pool. Each run writes per-meter pass/fail results and timing to Excel.',
        'Later versions added continuous and scheduled test sessions (pick days, a start time and a duration, then leave it running overnight), bulk configuration changes across selected meters, multiple test tabs with saved profiles, and a custom UI. It ships as a standalone .exe that installs its own dependencies on first run.',
      ],
      media: [
        { type: 'image', src: '', caption: 'TODO: a screenshot of the scan view (blur any IPs or MAC addresses)' },
      ],
    },
    {
      id: 'engorg',
      short: 'EngOrg',
      title: 'EngOrg: engineering workspace',
      date: '2025 to present · Personal project',
      summary: 'A desktop app, phone app, Android notebook and Raspberry Pi service I built to run my engineering coursework and lab work from one place.',
      tags: ['Software', 'Electron', 'Android', 'Embedded'],
      links: [{ label: 'Open the web app', url: 'https://assistant-taskboard.web.app' }],
      body: [
        'EngOrg started as a task board and grew into a full workspace: projects and deadlines pulled in automatically from Gradescope, Brightspace and calendar feeds; a 3D-printer dashboard that talks to Klipper over Moonraker and slices with OrcaSlicer; a CAD viewer; and a set of engineering utilities including a circuit simulator, a thermodynamics solver and a UART bridge.',
        'It runs on four platforms that share one data model through Firebase: an Electron desktop app, an installable web app, an Android pen-notebook app (EngInk) that recognises hand-drawn circuit symbols and solves them, and a headless Raspberry Pi build that keeps printer logs and calendar caches running 24/7.',
        'Everything ships through a release pipeline I wrote: one command versions the desktop installer, the Android APK and the Pi bundle, and linked Raspberry Pis update themselves.',
      ],
      media: [
        { type: 'image', src: '', caption: 'TODO: add a screenshot, e.g. /portfolio/assets/images/engorg-board.png' },
      ],
    },
  ],
};
