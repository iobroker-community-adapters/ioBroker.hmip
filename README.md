![Logo](admin/homematic.png)
# ioBroker HomeMatic IP Cloud AccessPoint Adapter
=================

[![NPM version](http://img.shields.io/npm/v/iobroker.hmip.svg)](https://www.npmjs.com/package/iobroker.hmip)
[![Downloads](https://img.shields.io/npm/dm/iobroker.hmip.svg)](https://www.npmjs.com/package/iobroker.hmip)
[![Build Status](https://travis-ci.org/iobroker-community-adapters/ioBroker.hmip.svg?branch=master)](https://travis-ci.org/iobroker-community-adapters/ioBroker.hmip.svg?branch=master)

[![NPM](https://nodei.co/npm/iobroker.hmip.png?downloads=true)](https://nodei.co/npm/iobroker.hmip/) [![Greenkeeper badge](https://badges.greenkeeper.io/iobroker-community-adapters/ioBroker.hmip.svg)](https://greenkeeper.io/)

## Description
This adapter allows to Communicate with a HomaticIP CloudAccessPoint via the Rest API of the Homatic Cloud

## Installation
This Adapter needs node-js in version >= 8.0

## Info
At the Moment only a few Devices are supported.

I will improve it, but it will take time. For not working devices, please create an issue (one per device).
Then switch adapter logging to silly mode and add the json of the device wich is printed to the log.
I may also need a json of a state change.

## Included Devices

    BRAND_SWITCH_MEASURING (HMIP-BSM)
    FULL_FLUSH_SWITCH_MEASURING (HMIP-FSM)
    PLUGABLE_SWITCH_MEASURING (HMIP-PSM)
    PLUGABLE_SWITCH (HMIP-PS)
    BRAND_WALL_MOUNTED_THERMOSTAT (HMIP-BWTH)
    WALL_MOUNTED_THERMOSTAT_PRO (HMIP-WTH, HMIP-WTH-2)
    TEMPERATURE_HUMIDITY_SENSOR_DISPLAY (HMIP-STHD)
    HEATING_THERMOSTAT (HMIP-eTRV, HMIP-eTRV2, HMIP-eTRV-B, HMIP-eTRV-B1)
    SHUTTER_CONTACT (HMIP-SWDO)
    SHUTTER_CONTACT_MAGNETIC (HMIP-SWDM, HMIP-SWDM-B2)
    BRAND_DIMMER (HMIP-BDT)
    PLUGGABLE_DIMMER (HMIP-PDT)
    PUSH_BUTTON (HMIP-WRC2)
    PUSH_BUTTON_6 (HMIP-WRC6)
    OPEN_COLLECTOR_8_MODULE (HmIP-MOD-OC8)
    REMOTE_CONTROL_8 (HMIP-RC8)
    BRAND_SHUTTER (HMIP-BROLL)
    MOTION_DETECTOR_INDOOR (HMIP-SMI)
    SMOKE_DETECTOR (HMIP-SWSD)
    WATER_SENSOR (HMIP-SWD)
    ROTARY_HANDLE_SENSOR (HMIP-SRH)
    BRAND_BLIND (HMIP-BBL)
    ALARM_SIREN_INDOOR (HMIP-ASIR, HMIP-ASIR-B1)

## Settings
* specify the your SGTIN and the PIN of your Accesspoint, and validate via press of the blue Button. This will create a Authentication token.

## Thanks

to coreGreenberet for his python lib (https://github.com/coreGreenberet/homematicip-rest-api)

## Diskussion in ioBroker Forum
https://forum.iobroker.net/viewtopic.php?f=36&t=21000#p220517

## Adapter Request auf GitHub
https://github.com/ioBroker/AdapterRequests/issues/62

## Changelog

### 0.0.9
* (jogibear9988) fullrx and operationlock channel

### 0.0.8
* (jogibear9988) fixes a few devices

### 0.0.7
* (jogibear9988) fixes wrong state handling

### 0.0.6
* (jogibear9988) fixes for more devices, alarm handling

### 0.0.5
* (jogibear9988) more devices and big refactoring (switched from DeviceType to FunctionalChannelType)

### 0.0.4
* (jogibear9988) more devices, bugfixes. thanks to TobiasF1986, steckenpferd and Ma-ster77

### 0.0.3
* (jogibear9988) bugfixes and more devices 

### 0.0.2
* (jogibear9988) bugfixes, more devices and initial support of groups

### 0.0.1
* (jogibear9988) initial release

## License
The MIT License (MIT)

Copyright (c) 2018 @@Author@@ <@@email@@>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
