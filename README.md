# logsync
Synchronize Woolich Logbox XML exports to Track Addict CSV files by matching speed.
Currently must be run from a server, python http.server works fine for localhost:port loading.
Tested on exports from Logbox-K v3 logs exported to XML by Woolich Racing Tuned and TrackAddict CSV Interpolated exports.
Useful for combining Woolich Data with video in RaceRender, or using sensors feeding by HP Tuners NBP via Wifi or Bluetooth.

Future Plans:
1. Racebox CSV Export Support
2. GoPro Hero 11+ Video Sync
3. AutoTune functionality (AFR by ETV/RPM or IAP/RPM)
4. Decode WRL files directly
5. Repair corrupted WRL files (coming soon)
6. Either hosted version online or port to an executable
