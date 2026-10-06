# Cheapest hardware options for CommitOS

Checked **6 October 2026**. Prices below are **India examples**; the user's country is unconfirmed. Stock and prices can change.

## Recommendation: reuse a computer and phone — ₹0 extra hardware

Run or build CommitOS on an existing computer, then open it in an existing Android phone's browser. The phone already provides a display, microphone, battery and storage. This is the cheapest path that works with the current application.

The computer must remain available as the app server, or CommitOS must be deployed to an app host. **Supabase supplies the database and authentication; it does not host this Next.js application.** A phone browser alone does not run the Node server. Electricity, internet and any paid hosting are separate costs.

## Raspberry Pi host — ₹7,310 listed, unavailable

[Silverline Raspberry Pi 4 2GB starter kit](https://www.silverlineelectronics.in/products/silverline-raspberry-pi-4-model-b-2-gb-starter-kit): **₹7,310, out of stock** when checked. Includes the Pi, 16GB microSD, power supply, case, HDMI cable and heatsinks. An existing phone could provide the browser display and microphone without another hardware purchase. A separate monitor, keyboard or microphone would add costs.

Linux setup would be required. CommitOS has **not been tested on this kit**. This is a price reference, not a recommendation to buy an unavailable product.

## ESP32 display prototype — ₹901 plus shipping

These parts were listed in stock when checked:

| Part | Listed price |
| --- | ---: |
| [ESP32 development board](https://robocraze.com/products/esp32-development-board) | ₹425 |
| [0.91-inch OLED display](https://robocraze.com/products/0-91-inch-blue-oled-display-module) | ₹159 |
| [5V power adapter with micro-USB data cable](https://robocraze.com/products/5v-3a-erd-power-adapter) | ₹282 |
| [Female-to-female jumper wires](https://robocraze.com/products/f2f-jumper-wires-20cm-20pcs) | ₹35 |
| **Parts total** | **₹901** |

This is a bare prototype bill, excluding shipping, enclosure and microphone. A simple display client would not require a microSD card. Reusing a suitable USB supply and cable reduces the parts total to ₹619.

**ESP32 cannot run the current Next.js/Node application.** Its embedded processor and memory are documented in the [Espressif datasheet](https://documentation.espressif.com/esp32_datasheet_en.html). It could become a tiny records display only after custom firmware and an API client are built; it would still need CommitOS running on a computer or app host. That client does not exist in the current app.

## Used phones and voice

The [Cashify Redmi 9A listing](https://www.cashify.in/buy-refurbished-mobile-phones/renewed-xiaomi-redmi-9a) showed **₹5,499 and out of stock**. Charger/cable inclusion was not verified, so this is not a confirmed purchasable, complete setup.

Browser speech recognition has limited availability. Chrome may use a remote recognition service and require internet; do not assume voice works in a stock Raspberry Pi browser or offline. Typed capture remains available. See [MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).
