<span align="center">

# Homebridge P1 Tools
[![Downloads](https://img.shields.io/npm/dt/hb-p1-tools.svg)](https://www.npmjs.com/package/hb-p1-tools)
[![Version](https://img.shields.io/npm/v/hb-p1-tools.svg)](https://www.npmjs.com/package/hb-p1-tools)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

</span>

## Homebridge P1 Tools
Copyright © 2018-2026 Erik Baauw. All rights reserved.

This repository provides a standalone installation of the command-line utilities from [Homebridge P1](https://github.com/ebaauw/homebridge-p1):

Tool      | Description
--------- | -----------
`p1`      | Logger for data received from the smart meter.

Each command-line tool takes a `-h` or `--help` argument to provide a brief overview of its functionality and command-line arguments.

This repository uses the end-consumer (P1) interface of the [Dutch Smart Meter Requirements (DSMR)](https://www.netbeheernederland.nl/_upload/Files/Slimme_meter_15_a727fce1f1.pdf) to connect to a smart meter.

The smart meter sends a push notification ("telegram" in DSMR speak), every second, updating the electricity consumption almost in real time.
Older versions of DSMR might send notifications less frequently.
Gas consumption is updated every 5 minutes.

### Prerequisites
You need a smart meter that provides a P1 port that complies to DSMR (currently DSMR 5.0, DSMR 4.2, and DSMR 2.2+ are tested).<br>
The companies maintaining the electricity and natural gas networks in the Netherlands, united in [Netbeer Nederland](https://www.netbeheernederland.nl) are [replacing](https://www.onsenergie.net/slimme-meter/) existing electricity and gas meters with smart meters.
In my home, they installed a [Landys +Gyr E350 (ZCF1100)](https://www.landisgyr.eu/product/landisgyr-e350-electricity-meter-new-generation/).<br>
Smart meters in [Flandres (Belgium)](https://www.fluvius.be/sites/fluvius/files/2019-12/e-mucs_h_ed_1_3.pdf), Luxembourg, and [Sweden](https://hanporten.se/svenska/protokollet/) might provide a P1 port as well.
I don't know about the rollout plans in those countries.
One Flandres installation is reported working, see [#47](https://github.com/ebaauw/homebridge-p1/issues/47); one Swedish installation is reported not working, see [#50](https://github.com/ebaauw/homebridge-p1/issues/50).

You need a cable to connect the smart meter's P1 port to a USB port.
I got mine [here](https://www.sossolutions.nl/slimme-meter-kabel), but you could also make one yourself, as described [here](http://gejanssen.com/howto/Slimme-meter-uitlezen/).
The cable is quite short (~1m) but you can extend it using a regular USB extension cable (female-A to A).<br>
The cable provides a serial port device to the system.

Preferably, `ser2net` is used to expose serial port device over a network socket.
See the [Wiki](https://github.com/ebaauw/homebridge-p1/wiki/Multiple-Concurrent-Connections-to-the-Smart-Meter#using-ser2net-as-relay)
for an example configuration.

Alternatively, this repository can use the [`serialport`](https://github.com/serialport/node-serialport) package to connect directly to the serial port device.
This package uses some non-JavasScript addons, that need to be compiled on installation.
The server running this repository needs to have the appropriate development tools installed.

The user running `p1` needs privileges to list the serial port devices and to open the serial port device for the P1 cable.
Under Raspbian, user `pi` has these privileges by default.
If you run Homebridge under a different user, make sure it's member of the `dialout` group, and, for Buster, of the `gpio` group.
