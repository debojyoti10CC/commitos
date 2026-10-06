> Historical hardware proposal. The current product is the automatic capture-and-organize app documented in README.md. The focus/start desk UI described here is superseded; /desk now opens the main records app. No board firmware or hardware purchase was performed.

# CommitOS desk hub

Use an existing Raspberry Pi and screen for the first desk hub. Chromium can run the working `/desk` page, share the same account as the main app, and use the existing capture and focus controls. The ESP32 boards below are optional candidates for a later firmware project. This phase supplies browser desk mode, a device snapshot API, token management, and this hardware plan; it does not supply flashed or physically tested ESP32 firmware.

Research checked **5 October 2026**. Prices are observations from vendor pages, not orders or guaranteed checkout totals.

## Start with the browser

Reuse a Pi, its correct power supply, microSD card, monitor, and appropriate display cable. Raspberry Pi's current kiosk guide calls for a Pi 3 or newer with at least 1 GB RAM and Raspberry Pi OS 64-bit. A keyboard/mouse or touchscreen handles the initial login. Open the app normally, sign in, verify `/desk`, then use Chromium kiosk mode. The current labwc desktop starts applications through `~/.config/labwc/autostart`; older images use different desktop configuration. Adapt this single-page command to the app's actual HTTPS origin. [Official Raspberry Pi kiosk guide](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/)

```bash
chromium 'https://YOUR_APP/desk' --kiosk --no-first-run --start-maximized
```

Keep the browser profile persistent so login survives a reboot. A Pi browser in local demo mode receives its own isolated dataset; use the same production Supabase account on both computers to share commitments. Running the app on another computer means `localhost` on the Pi points to the Pi itself. Use the deployed HTTPS origin, or configure a suitable local HTTPS origin.

The desk button uses these browser gestures: one press starts the selected commitment, two presses complete it, and a hold opens capture. **Holding opens the capture dialog; it does not implement recording only while the button is held.** Use the dialog's microphone control where supported, or type. A keyboard or USB input that produces browser events is sufficient for this phase; a GPIO button/rotary encoder needs an additional input bridge.

Browser speech recognition has uneven browser support and can send audio to the browser provider's service. Do not assume Raspberry Pi Chromium supports working recognition merely because the API name exists. Test a real utterance on the target browser and retain text capture. [SpeechRecognition documentation](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)

Use HTTPS and grant microphone permission. Browser microphone capture through `getUserMedia` requires a secure context; `localhost` qualifies, while an ordinary HTTP LAN address does not. A working microphone also needs OS input configuration. These conditions do not guarantee speech-service availability. [Microphone access requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

## Optional board candidates

| Candidate                             | Verified hardware                                                                                                                                                                                                                                                  | Practical fit                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M5Stack CoreS3 SE, K128-SE**        | 2.0-inch 320×240 ILI9342C SPI IPS display; FT6336U capacitive touch; dual microphones through ES7210; AW88298 I2S amplifier and built-in 1 W speaker; ESP32-S3, 16 MB flash, 8 MB Quad PSRAM, 2.4 GHz Wi-Fi, USB-C, microSD and RTC.                               | Compact touch hub with an integrated speaker. No included battery. SE removes the full CoreS3's camera, proximity sensor, IMU, compass and battery base; do not buy full CoreS3 accessories or copy sensor examples assuming those parts exist. [CoreS3 SE specification and comparison](https://docs.m5stack.com/en/core/CoreS3-SE) |
| **Waveshare ESP32-S3-Touch-LCD-4.3C** | SKU **33799** bare board, **33630 / 4.3C-BOX** with plastic case; 4.3-inch 800×480 RGB565 display, GT911 five-point capacitive touch, ES7210 microphone ADC and ES8311 playback codec; 16 MB flash, 8 MB PSRAM, 2.4 GHz Wi-Fi, RTC, microSD, I2C and isolated I/O. | Larger NOW/NEXT display. The exact suffix is **C**; the 4.3/B HMI boards have different interfaces and examples. [Official 4.3C documentation](https://docs.waveshare.com/ESP32-S3-Touch-LCD-4.3C), [4.3B variant](https://docs.waveshare.com/ESP32-S3-Touch-LCD-4.3B)                                                               |

Waveshare lists dual microphones and a speaker connector, plus a single-cell battery connector. Its package list does not separately identify a speaker or battery. Confirm the exact delivered speaker, impedance, connector and battery contents with the vendor before adding audio accessories. Treat the board as having a verified audio path, rather than assuming a complete speaker/battery bundle. [Manufacturer product and package contents](https://www.waveshare.com/product/arduino/boards-kits/esp32-s3/esp32-s3-touch-lcd-4.3c.htm)

Neither ESP32 candidate runs the Next.js interface directly. A later client would render its own small UI and call CommitOS over HTTPS. This is an engineering compatibility assessment, not a completed hardware test.

## Controls and pin constraints

CoreS3 SE exposes external Grove Port A on **SDA GPIO2 / SCL GPIO1**. Its internal codec/touch bus instead uses SDA12/SCL11. Audio occupies MCLK0, BCLK34, WS33, microphone data13 and speaker data14; exposed M-Bus pins are not all free GPIO. Use the board library to configure these peripherals. [CoreS3 SE pin map](https://docs.m5stack.com/en/core/CoreS3-SE)

For a future physical knob, **M5 Unit Encoder U135** provides an I2C rotary encoder and pushbutton at address `0x40`. Its own controller reads the encoder, avoiding a raw quadrature timing loop. Port A is a reasonable CoreS3 SE candidate because it is separate from the internal ES7210 bus, also addressed `0x40`. Check power, cable orientation and the official library on the actual board. No Indian encoder price was verified. [Unit Encoder specification](https://docs.m5stack.com/en/unit/Unit_Encoder), [official protocol](https://m5stack-doc.oss-cn-shenzhen.aliyuncs.com/801/Unit-Encoder_Protocol.pdf)

CoreS3's power button exposes `wasClicked` and `wasHold` through its power-management chip, rather than ordinary press/release input. Long holds also power the unit off. Use touch or a dedicated external control for true push-to-talk. Keep the library update loop responsive. [Official button API](https://docs.m5stack.com/en/arduino/m5cores3/button)

For Waveshare **V1.1 / ESP32-S3-WROOM-1-N16R8**, the first-party schematic-backed reference gives I2C SDA8/SCL9, touch IRQ4, and audio MCLK6/BCLK44/WS16/output15/input43. It specifies one-bit SDMMC CLK12/CMD11/D0=13. These are occupied signals, not a suggested encoder wiring diagram. The RGB display consumes many other GPIO. [Official hardware reference](https://github.com/waveshareteam/ESP32-S3-Touch-LCD-4.3C/blob/main/HARDWARE_REFERENCE.md)

**Waveshare source conflict requires a board check:** the main documentation labels amplifier control EXIO4, whereas that reference assigns amplifier enable IO3 and SD control IO4. Some legacy audio READMEs incorrectly list MCLK4. The published BSP and older examples also name the I/O expander differently. Confirm the received PCB revision against its schematic, run the matching factory examples, and retain the validated driver. Do not mix these sources into an invented pin map. Verify I2C addresses and external port voltage before attaching an encoder; a shared-bus accessory can collide with an onboard codec. [Hardware reference](https://github.com/waveshareteam/ESP32-S3-Touch-LCD-4.3C/blob/main/HARDWARE_REFERENCE.md), [documented component naming conflict](https://github.com/waveshareteam/ESP32-S3-Touch-LCD-4.3C/blob/main/docs/components.md)

## Firmware evidence for a later phase

M5Stack supports Arduino, UiFlow2, ESP-IDF and PlatformIO. The SE Arduino guide selects **M5CoreS3** and uses **M5Unified + M5GFX**. Start from the official microphone example, then the display and button examples. The current microphone example requires board package ≥3.2.2 and M5Unified ≥0.2.11; it stops the speaker before recording and stops the microphone before playback. This validates a recording/playback path in the example, not simultaneous duplex audio. [SE Arduino setup](https://docs.m5stack.com/en/arduino/m5cores3_se/program), [microphone example](https://docs.m5stack.com/en/arduino/m5cores3/mic)

Waveshare supplies Arduino and ESP-IDF examples, including **11_speaker_microphone**, **12_lvgl_transplant**, **13_lvgl_codec**, and **14_tcp_udp_ntp**. Pin a published example package and its matching library versions. Legacy Arduino examples use LVGL 8.4; the managed BSP uses a different LVGL generation, so do not mix them. The official repository records compilation checks, but explicitly leaves display, touch, codec routing and I/O validation to physical testing. [ESP-IDF examples](https://docs.waveshare.com/ESP32-S3-Touch-LCD-4.3C/ESP-IDF), [Arduino guidance](https://docs.waveshare.com/ESP32-S3-Touch-LCD-4.3C/Arduino), [first-party source and releases](https://github.com/waveshareteam/ESP32-S3-Touch-LCD-4.3C)

Waveshare's Xiaozhi AI tutorial is evidence of a supported voice-demo firmware path. It is a separate assistant/service integration and is not a CommitOS client. Custom CommitOS HTTP actions and transcription integration remain work. [Official AI tutorial](https://docs.waveshare.com/ESP32-S3-Touch-LCD-4.3C/ESP32-AI-Tutorials)

## Server contract and voice boundary

The browser `/desk` page uses the authenticated app session. A future device uses a token created in Settings; the server stores its hash, the raw token is shown once, and revocation disables it. The device holds only its own token and Wi-Fi configuration. Google, Gemini, Telegram and database credentials remain on the server. See the [application README](../README.md) for setup and the shared `lib/device/snapshot.ts` contract for snapshot semantics.

| Device request                                                | Purpose                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/device/snapshot`                                    | Read the shared desk snapshot used by browser desk mode.                              |
| `GET /api/device/now` and `GET /api/device/next`              | Legacy recommendation responses.                                                      |
| `POST /api/device/capture` with `{ "text": "..." }`           | Capture a transcript/text, 3–5000 characters; ambiguous captures require review.      |
| `POST /api/device/:id/start`, `/pause`, `/complete` with `{}` | Update the user-owned commitment/session. Refresh the snapshot after acknowledgement. |

Every device request requires `Authorization: Bearer DEVICE_TOKEN`. Example commands below run on a development computer; set `COMMITOS_APP_URL` and `COMMITOS_DEVICE_TOKEN` locally without putting a real token into this document or source control.

The shared snapshot has `version: 1`, `state_version`, `server_time`, `timezone`, `local_date`, `now`, `next` (at most three tasks), `timer`, `capacity` and `risk_counts`. A task carries its ID, title, project, status, deadline, estimated/remaining minutes, progress and risk explanation. `now` prefers the running focus session. Timer timestamps come from the server; elapsed work adjusts displayed progress without completing the task automatically. `capacity.signal` is `green`, `yellow`, `red` or `flashing_red`; flashing means today's due-work deficit or an imminent impossible commitment. A distant impossible item still contributes to risk counts without forcing a flash. Render `capacity.reason` alongside color so meaning does not depend on color alone.

```bash
curl --fail-with-body "$COMMITOS_APP_URL/api/device/snapshot" \
  --header "Authorization: Bearer $COMMITOS_DEVICE_TOKEN"

curl --fail-with-body "$COMMITOS_APP_URL/api/device/capture" \
  --header "Authorization: Bearer $COMMITOS_DEVICE_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"text":"Send the client update tomorrow at 6 pm, twenty minutes."}'
```

**Raw ESP32 audio upload and server transcription are not implemented.** The capture route accepts text JSON, not WAV, PCM or multipart audio. Browser SpeechRecognition cannot be moved to ESP32 as a firmware API. A later voice path needs bounded I2S recording, a separate authenticated upload endpoint with audio-specific size/type limits, server transcription, transcript review, then commitment capture.

A possible first recording format is 16 kHz, 16-bit mono PCM: ten seconds needs approximately 320 kB, before headers. This calculated design estimate exceeds the existing 64 kB JSON request limit; base64 in the text endpoint is not a substitute. Start with bounded push-to-talk and sequential playback. Add capture idempotency before automatically retrying an uncertain upload/capture response, plus clear offline/stale/error states, HTTPS certificate validation and clock sync. These are future implementation requirements, not existing firmware behavior.

## Buying list and checked Indian prices

Buy **one** board only after browser desk mode proves useful. An existing Pi and display require no replacement purchase for this plan. Microphone, cable, power supply, enclosure and encoder costs depend on what is already owned and the chosen board; no unverified bundle total is presented. NFC is unnecessary for capture/start/complete and is omitted. A prior ₹500–1000 NFC estimate or any uncited earlier price remains **unconfirmed**.

| Optional part / vendor                                                                                                | Observed price on 5 October 2026                                                         | Stock shown / tax / shipping                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [M5Stack CoreS3 SE, ElectroPi EPI27764](https://www.electropi.in/m5stack-cores3-se-iot-controller-w-o-battery-bottom) | **₹4,866 excluding 18% GST**; calculated tax-inclusive amount ₹5,741.88 before shipping. | Availability **5** shown; battery bottom excluded. Shipping and final checkout total unverified.                                                     |
| [Waveshare 4.3C bare, Hubtronics SKU33799](https://hubtronics.in/esp32-s3-touch-lcd-4-3c)                             | **₹4,320 including 18% GST**.                                                            | **20** shown. Page advertises eligible surface shipping, but says shipping is calculated at checkout; address eligibility/final shipping unverified. |
| [Waveshare 4.3C-BOX, Hubtronics SKU33630](https://hubtronics.in/esp32-s3-touch-lcd-4-3c-box)                          | **₹4,935 including 18% GST**.                                                            | **2** shown on the freshly opened canonical page. Shipping/arrival date unverified; confirm speaker contents.                                        |

The BOX premium is **₹615**, calculated from these two listings. Stock counts are page observations and may change before ordering. The CoreS3 SE is smaller and has an explicitly built-in speaker; the Waveshare C offers a larger interface and a checked enclosure option. These are alternatives with different bring-up work, not interchangeable firmware targets.

## Bring-up acceptance

1. **Browser first:** sign into the same account on the desk display and main app; verify NOW/NEXT, risk explanation, timer continuity after refresh, empty state, capture review, single/double/hold gestures and network-error recovery. Test actual speech recognition on that Pi/browser; typed capture remains usable when it fails.
2. **Board identity:** record SKU and PCB revision; compare received contents with the order. Flash a matching manufacturer display/touch example and verify orientation, color and reliable power before attaching controls.
3. **Audio and controls:** record/play a bounded clip with the exact vendor example; measure intelligibility at desk distance. Validate pushbutton press/release, encoder direction, debounce and long holds; confirm no reset/power-off side effects or I2C address collision.
4. **Device API:** create a token, fetch a snapshot, start/pause/complete a commitment and verify the main app reflects each acknowledgement. Revoke it and confirm subsequent calls return 401. Check that another account's token cannot read or change this user's work.
5. **Firmware durability, later:** test power loss, bad Wi-Fi, stale snapshots, server 401/429/5xx, uncertain responses and bounded retry behavior. Audio upload/transcription and idempotent capture must pass their own tests before voice capture is called complete.

No physical board, Pi kiosk, microphone, speaker or encoder has been exercised as part of this hardware research. Official specifications and examples establish candidates; hardware acceptance remains to be run on the selected device.
