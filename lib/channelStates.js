'use strict';

/**
 * Read-only ioBroker states for functional channel types that the adapter maps generically.
 *
 * Field names and value types come from real payloads reported by the adapter's own
 * "Unknown Channel type" telemetry, cross-checked against the reference implementation.
 * A handful of fields no payload has ever carried a value for are typed from their name
 * instead; those are marked ASSUMED below, because an ioBroker object keeps the type it was
 * created with and a wrong one is harder to undo than a missing state.
 *
 * Every state here is read-only. None of these channels has a write command wired up yet.
 */

// promoted onto DEVICE_BASE, so every device reports its own hardware faults

const DEVICE_BASE_STATES = {
    bootedRecently: { type: 'boolean', role: 'indicator' },
    coProFaulty: { type: 'boolean', role: 'indicator' },
    coProRestartNeeded: { type: 'boolean', role: 'indicator' },
    coProUpdateFailure: { type: 'boolean', role: 'indicator' },
    deviceOverheated: { type: 'boolean', role: 'indicator' },
    deviceOverloaded: { type: 'boolean', role: 'indicator' },
    devicePowerFailureDetected: { type: 'boolean', role: 'indicator' },
    deviceUndervoltage: { type: 'boolean', role: 'indicator' },
    lastBootTimestamp: { type: 'number', role: 'value.time' },
    multicastRoutingEnabled: { type: 'boolean', role: 'indicator' },
    profilePeriodLimitReached: { type: 'boolean', role: 'indicator' },
    temperatureOutOfRange: { type: 'boolean', role: 'indicator' },
};

const CHANNEL_STATES = {
    AIR_PRESSURE_SENSOR_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
            airPressure: { type: 'number', role: 'value.pressure', unit: 'hPa' },
        },
    },
    BACKLIGHT_CHANNEL: {
        states: {
            dimLevel: { type: 'number', role: 'value.brightness' },
            on: { type: 'boolean', role: 'indicator' },
            powerUpDimLevel: { type: 'number', role: 'value' },
            powerUpSwitchState: { type: 'string', role: 'text' },
            profileMode: { type: 'string', role: 'text' },
            switchVisualization: { type: 'string', role: 'text' },
            userDesiredProfileMode: { type: 'string', role: 'text' },
        },
    },
    BASE_WATER_SENSOR_CHANNEL: {
        states: {
            inAppWaterAlarmTrigger: { type: 'string', role: 'text' },
            sirenWaterAlarmTrigger: { type: 'string', role: 'text' },
            waterlevelDetected: { type: 'boolean', role: 'sensor.alarm.water' },
        },
    },
    CODE_PROTECTED_PRIMARY_ACTION_CHANNEL: {
        states: {
            actionCodeConfigured: { type: 'boolean', role: 'indicator' },
            actionParameter: { type: 'string', role: 'text' },
            authorized: { type: 'boolean', role: 'indicator' },
        },
    },
    CODE_PROTECTED_SINGLE_ACTION_CHANNEL: {
        states: {
            actionParameter: { type: 'string', role: 'text' },
            authorized: { type: 'boolean', role: 'indicator' },
            codeSelections: { type: 'string', role: 'json' },
        },
    },
    DEVICE_BLOCKING: {
        extends: 'DEVICE_BASE',
        states: {
            blockedSabotage: { type: 'boolean', role: 'indicator' },
            blockedWrongCodePermanently: { type: 'boolean', role: 'indicator' },
            blockedWrongCodeTemporarily: { type: 'boolean', role: 'indicator' },
            blockingPermanentAttempts: { type: 'number', role: 'value' },
            blockingTemporaryAttempts: { type: 'number', role: 'value' },
            sabotage: { type: 'boolean', role: 'sensor.alarm' },
        },
    },
    DEVICE_BLOCKING_WITH_TEACHABLE_CODE: {
        extends: 'DEVICE_BASE',
        states: {
            blockedSabotage: { type: 'boolean', role: 'indicator' },
            blockedWrongCodePermanently: { type: 'boolean', role: 'indicator' },
            blockedWrongCodeTemporarily: { type: 'boolean', role: 'indicator' },
            blockingPermanentAttempts: { type: 'number', role: 'value' },
            blockingTemporaryAttempts: { type: 'number', role: 'value' },
            code01Used: { type: 'boolean', role: 'indicator' },
            code02Used: { type: 'boolean', role: 'indicator' },
            code03Used: { type: 'boolean', role: 'indicator' },
            code04Used: { type: 'boolean', role: 'indicator' },
            code05Used: { type: 'boolean', role: 'indicator' },
            code06Used: { type: 'boolean', role: 'indicator' },
            code07Used: { type: 'boolean', role: 'indicator' },
            code08Used: { type: 'boolean', role: 'indicator' },
            code09Used: { type: 'boolean', role: 'indicator' },
            code10Used: { type: 'boolean', role: 'indicator' },
            code11Used: { type: 'boolean', role: 'indicator' },
            code12Used: { type: 'boolean', role: 'indicator' },
            code13Used: { type: 'boolean', role: 'indicator' },
            code14Used: { type: 'boolean', role: 'indicator' },
            code15Used: { type: 'boolean', role: 'indicator' },
            code16Used: { type: 'boolean', role: 'indicator' },
            code17Used: { type: 'boolean', role: 'indicator' },
            code18Used: { type: 'boolean', role: 'indicator' },
            code19Used: { type: 'boolean', role: 'indicator' },
            code20Used: { type: 'boolean', role: 'indicator' },
            codeLabels: { type: 'string', role: 'json' },
            contactType: { type: 'string', role: 'text' },
            doorBellLabel: { type: 'string', role: 'text' },
            sabotage: { type: 'boolean', role: 'sensor.alarm' },
        },
    },
    DEVICE_GLASS_DISPLAY: {
        extends: 'DEVICE_BASE',
        states: {
            coProVersionMismatch: { type: 'boolean', role: 'indicator' },
            detectionRange: { type: 'number', role: 'value' },
            displayBacklightDuration: { type: 'number', role: 'value' },
            displayBacklightOffset: { type: 'number', role: 'value' },
            displayLanguage: { type: 'string', role: 'text' },
            indoorClimateScreenLayouts: { type: 'string', role: 'json' },
            inputScreenLayouts: { type: 'string', role: 'json' },
            screenLabels: { type: 'string', role: 'json' },
            screenOrder: { type: 'string', role: 'json' },
        },
    },
    DEVICE_OPERATIONLOCK_WITH_SABOTAGE: {
        extends: 'DEVICE_OPERATIONLOCK',
        states: {
            lockJammed: { type: 'boolean', role: 'indicator' },
            sabotage: { type: 'boolean', role: 'sensor.alarm' },
            sabotageSensitivity: { type: 'number', role: 'value' }, // ASSUMED
        },
    },
    DOOR_LOCK_PRO_CHANNEL: {
        states: {
            accelerationSabotageMode: { type: 'string', role: 'text' },
            accelerationSabotageSensitivity: { type: 'number', role: 'value' },
            accelerationSabotageTiltAngle: { type: 'number', role: 'value' },
            acousticChannelstateDisabled: { type: 'boolean', role: 'indicator' },
            autoRelockDelay: { type: 'number', role: 'value', unit: 's' },
            autoRelockEnabled: { type: 'boolean', role: 'indicator' },
            doorHandleType: { type: 'string', role: 'text' },
            doorLockDirection: { type: 'string', role: 'text' },
            doorLockEndStopOffsetLocked: { type: 'string', role: 'text' },
            doorLockEndStopOffsetOpen: { type: 'string', role: 'text' },
            doorLockInputActionLongPress: { type: 'string', role: 'text' },
            doorLockInputActionShortPress: { type: 'string', role: 'text' },
            doorLockLoadCalibration: { type: 'number', role: 'value' },
            doorLockNeutralPosition: { type: 'string', role: 'text' },
            doorLockTurns: { type: 'number', role: 'value' },
            doorOpenReminderDelay: { type: 'number', role: 'value' },
            doorOpeningDirection: { type: 'string', role: 'text' },
            doorSensorAutoRelockDelayShortingEnabled: { type: 'boolean', role: 'indicator' },
            errorLoadTooLowDuringLockingActive: { type: 'boolean', role: 'indicator' },
            errorLockedWhileDoorOpenActive: { type: 'boolean', role: 'indicator' },
            errorNoEndStopLockActive: { type: 'boolean', role: 'indicator' }, // ASSUMED
            errorNoEndStopUnlockActive: { type: 'boolean', role: 'indicator' }, // ASSUMED
            errorOpenedWhileDoorLockedAcknowledged: { type: 'boolean', role: 'indicator' },
            errorOpenedWhileDoorLockedActive: { type: 'boolean', role: 'indicator' },
            holdTime: { type: 'string', role: 'text' },
            lastDoorOpenReminderTimestamp: { type: 'number', role: 'value.time' },
            lastLockDriveLoad: { type: 'number', role: 'value' },
            lockSilenceMode: { type: 'string', role: 'text' },
            lockState: { type: 'string', role: 'text' },
            lockStateChangeReason: { type: 'string', role: 'text' },
            lockTeachInState: { type: 'string', role: 'text' },
            motorState: { type: 'string', role: 'text' },
            permissionChannelIndex: { type: 'number', role: 'value' },
            sabotageAcceleration: { type: 'boolean', role: 'indicator' },
            sabotageAccelerationAcknowledged: { type: 'boolean', role: 'indicator' },
            sabotageBattery: { type: 'boolean', role: 'indicator' },
            sabotageBatteryAcknowledged: { type: 'boolean', role: 'indicator' }, // ASSUMED
            sabotageMagneticField: { type: 'boolean', role: 'indicator' },
            sabotageMagneticFieldAcknowledged: { type: 'boolean', role: 'indicator' }, // ASSUMED
            sabotageVertical: { type: 'boolean', role: 'indicator' },
            sabotageVerticalAcknowledged: { type: 'boolean', role: 'indicator' }, // ASSUMED
        },
    },
    DOOR_LOCK_SENSOR_BASE_CHANNEL: {
        states: {
            lockState: { type: 'string', role: 'text' },
        },
    },
    DOOR_SWITCH_CHANNEL: {
        states: {
            doorLockActive: { type: 'boolean', role: 'indicator' },
            impulseDuration: { type: 'number', role: 'value', unit: 's' },
            multiModeInputMode: { type: 'string', role: 'text' },
            processing: { type: 'boolean', role: 'indicator' },
            profileMode: { type: 'string', role: 'text' },
            userDesiredProfileMode: { type: 'string', role: 'text' },
        },
    },
    EXTERNAL_ACCESS_EVENT_CHANNEL: {
        states: {
            accessEventRegistrationStatus: { type: 'string', role: 'text' }, // ASSUMED
            accessEventRegistrations: { type: 'string', role: 'json' },
            channelId: { type: 'string', role: 'text' },
            fingerprintSensorEventTimestamp: { type: 'number', role: 'value.time' }, // ASSUMED
            keyCodeEventTimestamp: { type: 'number', role: 'value.time' }, // ASSUMED
            qrCodeEventTimestamp: { type: 'number', role: 'value.time' }, // ASSUMED
            remoteControlEventTimestamp: { type: 'number', role: 'value.time' }, // ASSUMED
            transponderEventTimestamp: { type: 'number', role: 'value.time' }, // ASSUMED
        },
    },
    EXTERNAL_BASE_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' },
            lowBat: { type: 'boolean', role: 'indicator.lowbat' },
            sabotage: { type: 'boolean', role: 'sensor.alarm' },
            unreach: { type: 'boolean', role: 'indicator.unreach' },
        },
    },
    EXTERNAL_CAMERA_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' },
        },
    },
    EXTERNAL_DOORBELL_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' },
            doorBellLabel: { type: 'string', role: 'text' },
            doorBellSensorEventTimestamp: { type: 'number', role: 'value.time' },
        },
    },
    EXTERNAL_DOOR_SWITCH_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' },
        },
    },
    EXTERNAL_HEAT_PUMP_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' },
            climateOperationMode: { type: 'string', role: 'text' },
            coolingTemperatureOffset: { type: 'number', role: 'value.temperature', unit: '°C' }, // ASSUMED
            heatingTemperatureOffset: { type: 'number', role: 'value.temperature', unit: '°C' }, // ASSUMED
            presenceMode: { type: 'string', role: 'text' },
            supplyTemperature: { type: 'number', role: 'value.temperature', unit: '°C' }, // ASSUMED
        },
    },
    EXTERNAL_HMIP_CAMERA_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' },
            enabledCameraEventPushNotificationTypes: { type: 'string', role: 'json' },
            motionDetectedByCamera: { type: 'boolean', role: 'sensor.motion' },
            noiseDetected: { type: 'boolean', role: 'sensor.noise' },
        },
    },
    EXTERNAL_HOT_WATER_SWITCH_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' },
            switchVisualization: { type: 'string', role: 'text' },
        },
    },
    EXTERNAL_SWITCH_CHANNEL: {
        states: {
            on: { type: 'boolean', role: 'indicator' },
            switchVisualization: { type: 'string', role: 'text' },
        },
    },
    EXTERNAL_UNIVERSAL_LIGHT_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' },
            colorTemperature: { type: 'number', role: 'value.color.temperature', unit: 'K' },
            dimLevel: { type: 'number', role: 'value.brightness' },
            hue: { type: 'number', role: 'value' },
            maximumColorTemperature: { type: 'number', role: 'value.color.temperature', unit: 'K' },
            minimalColorTemperature: { type: 'number', role: 'value.color.temperature', unit: 'K' },
            on: { type: 'boolean', role: 'indicator' },
            saturationLevel: { type: 'number', role: 'value' },
            switchVisualization: { type: 'string', role: 'text' },
        },
    },
    GENERIC_BATTERY_CHANNEL: {
        states: {
            batteryCapacity: { type: 'number', role: 'value', unit: 'Wh' },
            batteryLevel: { type: 'number', role: 'value.battery', unit: '%' },
            currentPowerConsumption: { type: 'number', role: 'value.power', unit: 'W' },
            deviceConsumptionCurtailed: { type: 'boolean', role: 'indicator' }, // ASSUMED
            deviceConsumptionCurtailmentEnd: { type: 'number', role: 'value' }, // ASSUMED
            deviceConsumptionCurtailmentTarget: { type: 'number', role: 'value' }, // ASSUMED
            deviceProductionCurtailed: { type: 'boolean', role: 'indicator' }, // ASSUMED
            deviceProductionCurtailmentEnd: { type: 'number', role: 'value' }, // ASSUMED
            deviceProductionCurtailmentTarget: { type: 'number', role: 'value' }, // ASSUMED
            energyCounterOne: { type: 'number', role: 'value.power.consumption', unit: 'kWh' },
            energyCounterOneType: { type: 'string', role: 'text' },
            energyCounterTwo: { type: 'number', role: 'value.power.consumption', unit: 'kWh' },
            energyCounterTwoType: { type: 'string', role: 'text' },
        },
    },
    GENERIC_CLIMATE_SENSOR_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
            humidity: { type: 'number', role: 'value.humidity', unit: '%' },
            illumination: { type: 'number', role: 'value.brightness', unit: 'lx' },
            raining: { type: 'boolean', role: 'sensor.rain' },
            storm: { type: 'boolean', role: 'indicator' },
            sunshine: { type: 'boolean', role: 'indicator' },
            todayRainCounter: { type: 'number', role: 'value', unit: 'mm' },
            todaySunshineDuration: { type: 'number', role: 'value', unit: 'min' },
            totalRainCounter: { type: 'number', role: 'value', unit: 'mm' },
            totalSunshineDuration: { type: 'number', role: 'value', unit: 'min' },
            windDirection: { type: 'number', role: 'value.direction', unit: '°' },
            windSpeed: { type: 'number', role: 'value.speed', unit: 'km/h' },
            yesterdayRainCounter: { type: 'number', role: 'value', unit: 'mm' },
            yesterdaySunshineDuration: { type: 'number', role: 'value', unit: 'min' },
        },
    },
    GENERIC_CONTACT_SENSOR_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' }, // ASSUMED
            triggered: { type: 'boolean', role: 'indicator' }, // ASSUMED
            windowState: { type: 'string', role: 'text' }, // ASSUMED
        },
    },
    GENERIC_ENERGY_METER_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' }, // ASSUMED
            currentPowerConsumption: { type: 'number', role: 'value.power', unit: 'W' },
            deviceConsumptionCurtailed: { type: 'boolean', role: 'indicator' }, // ASSUMED
            deviceConsumptionCurtailmentEnd: { type: 'number', role: 'value' }, // ASSUMED
            deviceConsumptionCurtailmentTarget: { type: 'number', role: 'value' }, // ASSUMED
            deviceProductionCurtailed: { type: 'boolean', role: 'indicator' }, // ASSUMED
            deviceProductionCurtailmentEnd: { type: 'number', role: 'value' }, // ASSUMED
            deviceProductionCurtailmentTarget: { type: 'number', role: 'value' }, // ASSUMED
            energyCounterOne: { type: 'number', role: 'value.power.consumption', unit: 'kWh' }, // ASSUMED
            energyCounterOneType: { type: 'string', role: 'text' },
            energyCounterTwo: { type: 'number', role: 'value.power.consumption', unit: 'kWh' },
            energyCounterTwoType: { type: 'string', role: 'text' },
        },
    },
    GENERIC_OCCUPANCY_SENSOR_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' },
            presenceDetected: { type: 'boolean', role: 'sensor.motion' },
        },
    },
    GENERIC_PARTICULATE_MATTER_SENSOR_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature' }, // ASSUMED
            airQualityIndexTen: { type: 'number', role: 'value' }, // ASSUMED
            airQualityIndexTwoPointFive: { type: 'number', role: 'value' }, // ASSUMED
            particulateMassConcentrationOne: { type: 'number', role: 'value', unit: 'µg/m³' },
            particulateMassConcentrationOneAverage: { type: 'number', role: 'value' }, // ASSUMED
            particulateMassConcentrationTen: { type: 'number', role: 'value', unit: 'µg/m³' },
            particulateMassConcentrationTenAverage: { type: 'number', role: 'value' }, // ASSUMED
            particulateMassConcentrationTwoPointFive: { type: 'number', role: 'value', unit: 'µg/m³' },
            particulateMassConcentrationTwoPointFiveAverage: { type: 'number', role: 'value' }, // ASSUMED
            particulateNumberConcentrationOne: { type: 'number', role: 'value' }, // ASSUMED
            particulateNumberConcentrationTen: { type: 'number', role: 'value' }, // ASSUMED
            particulateNumberConcentrationTenAverage: { type: 'number', role: 'value' }, // ASSUMED
            particulateNumberConcentrationTwoPointFive: { type: 'number', role: 'value' }, // ASSUMED
            particulateNumberConcentrationTwoPointFiveAverage: { type: 'number', role: 'value' }, // ASSUMED
            particulateTypicalSize: { type: 'number', role: 'value' }, // ASSUMED
        },
    },
    GENERIC_SMOKE_ALARM_CHANNEL: {
        states: {
            smokeDetectorAlarmType: { type: 'string', role: 'text' },
        },
    },
    GENERIC_SWITCH_INPUT_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' }, // ASSUMED
        },
    },
    GENERIC_THERMOSTAT_CHANNEL: {
        states: {
            setPointTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
        },
    },
    GENERIC_WATER_SENSOR_CHANNEL: {
        states: {
            inAppWaterAlarmTrigger: { type: 'string', role: 'text' },
            moistureDetected: { type: 'boolean', role: 'sensor.alarm.water' },
            waterlevelDetected: { type: 'boolean', role: 'sensor.alarm.water' },
        },
    },
    GENERIC_WINDOW_COVERING_CHANNEL: {
        states: {
            lastShadingDirection: { type: 'string', role: 'text' }, // ASSUMED
            previousShutterLevel: { type: 'number', role: 'value.blind' }, // ASSUMED
            previousSlatsLevel: { type: 'number', role: 'value.blind' }, // ASSUMED
            shutterLevel: { type: 'number', role: 'value.blind' },
            slatsLevel: { type: 'number', role: 'value.blind' }, // ASSUMED
        },
    },
    INPUT_TILE_DISPLAY_CHANNEL: {
        states: {
            controlRepresentation: { type: 'string', role: 'text' },
            displayMainText: { type: 'string', role: 'text' },
            displaySubText: { type: 'string', role: 'text' },
            inputTileBaseImageId: { type: 'number', role: 'value' },
            screenIndex: { type: 'number', role: 'value' },
            slatsViewPrefered: { type: 'boolean', role: 'indicator' },
            tileFunction: { type: 'string', role: 'text' },
            tileIndex: { type: 'number', role: 'value' },
        },
    },
    MAGNETIC_DOOR_SENSOR_CHANNEL: {
        states: {
            eventDelay: { type: 'number', role: 'value', unit: 's' },
            magneticDoorSensorMode: { type: 'string', role: 'text' },
            magneticDoorSensorSensitivity: { type: 'number', role: 'value' },
            windowState: { type: 'string', role: 'text' },
        },
    },
    MULTI_MODE_LOCK_INPUT_CHANNEL: {
        states: {
            actionParameter: { type: 'string', role: 'text' },
            binaryBehaviorType: { type: 'string', role: 'text' },
            corrosionPreventionActive: { type: 'boolean', role: 'indicator' },
            eventDelay: { type: 'number', role: 'value', unit: 's' },
            glassBroken: { type: 'boolean', role: 'indicator' },
            lockState: { type: 'string', role: 'text' },
            multiModeInputMode: { type: 'string', role: 'text' },
            windowState: { type: 'string', role: 'text' },
        },
    },
    OPTICAL_SIGNAL_CHANNEL: {
        states: {
            dimLevel: { type: 'number', role: 'value.brightness' },
            on: { type: 'boolean', role: 'indicator' },
            onMinLevel: { type: 'number', role: 'value' },
            opticalSignalBehaviour: { type: 'string', role: 'text' },
            powerUpDimLevel: { type: 'number', role: 'value' },
            powerUpOpticalSignalBehaviour: { type: 'string', role: 'text' },
            powerUpSimpleRGBColor: { type: 'string', role: 'text' },
            powerUpSwitchState: { type: 'string', role: 'text' },
            simpleRGBColorState: { type: 'string', role: 'text' },
            switchVisualization: { type: 'string', role: 'text' },
            userDesiredProfileMode: { type: 'string', role: 'text' },
        },
    },
    OPTICAL_SIGNAL_GROUP_CHANNEL: {
        states: {
            dimLevel: { type: 'number', role: 'value.brightness' },
            on: { type: 'boolean', role: 'indicator' },
            onMinLevel: { type: 'number', role: 'value' },
            opticalSignalBehaviour: { type: 'string', role: 'text' },
            powerUpDimLevel: { type: 'number', role: 'value' },
            powerUpOpticalSignalBehaviour: { type: 'string', role: 'text' },
            powerUpSimpleRGBColor: { type: 'string', role: 'text' },
            powerUpSwitchState: { type: 'string', role: 'text' },
            simpleRGBColorState: { type: 'string', role: 'text' },
            switchVisualization: { type: 'string', role: 'text' },
            userDesiredProfileMode: { type: 'string', role: 'text' },
        },
    },
    SOIL_MOISTURE_SENSOR_INTERFACE_CHANNEL: {
        states: {
            measuringInterval: { type: 'number', role: 'value', unit: 'min' },
            soilMoisture: { type: 'number', role: 'value', unit: '%' },
            soilMoistureMaximumReference: { type: 'number', role: 'value' },
            soilMoistureMinimumReference: { type: 'number', role: 'value' },
            soilMoistureNeutralMaximum: { type: 'number', role: 'value' },
            soilMoistureNeutralMinimum: { type: 'number', role: 'value' },
            soilMoistureRawValue: { type: 'number', role: 'value' },
            soilTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
            soilTemperatureNeutralMaximum: { type: 'number', role: 'value.temperature', unit: '°C' },
            soilTemperatureNeutralMinimum: { type: 'number', role: 'value.temperature', unit: '°C' },
        },
    },
    TEMPERATURE_SENSOR_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
        },
    },
    UNIVERSAL_ACTUATOR_CHANNEL: {
        states: {
            dimLevel: { type: 'number', role: 'value.brightness' },
            on: { type: 'boolean', role: 'indicator' },
            powerUpDimLevel: { type: 'number', role: 'value' },
            powerUpSwitchState: { type: 'string', role: 'text' },
            profileMode: { type: 'string', role: 'text' },
            relayMode: { type: 'string', role: 'text' },
            switchVisualization: { type: 'string', role: 'text' },
            userDesiredProfileMode: { type: 'string', role: 'text' },
            ventilationLevel: { type: 'number', role: 'value' },
            ventilationState: { type: 'string', role: 'text' },
        },
    },
    UNIVERSAL_DIMMING_CHANNEL: {
        states: {
            coProFaulty: { type: 'boolean', role: 'indicator' },
            coProRestartNeeded: { type: 'boolean', role: 'indicator' },
            deviceOverheated: { type: 'boolean', role: 'indicator' },
            deviceOverloaded: { type: 'boolean', role: 'indicator' },
            dimLevel: { type: 'number', role: 'value.brightness' },
            dimLevelHighest: { type: 'number', role: 'value.brightness' },
            dimLevelLowest: { type: 'number', role: 'value.brightness' },
            dimmingMode: { type: 'string', role: 'text' },
            internalLinkConfiguration: { type: 'string', role: 'json' },
            multiModeInputMode: { type: 'string', role: 'text' },
            on: { type: 'boolean', role: 'indicator' },
            onMinLevel: { type: 'number', role: 'value' },
            powerUpDimLevel: { type: 'number', role: 'value' },
            powerUpSwitchState: { type: 'string', role: 'text' },
            profileMode: { type: 'string', role: 'text' },
            rampTime: { type: 'number', role: 'value', unit: 's' },
            switchVisualization: { type: 'string', role: 'text' },
            universalDimmingMode: { type: 'string', role: 'text' },
            universalDimmingOperationMode: { type: 'string', role: 'text' },
            universalModeError: { type: 'boolean', role: 'indicator' },
            userDesiredProfileMode: { type: 'string', role: 'text' },
        },
    },
    WALL_MOUNTED_THERMOSTAT_WITH_CARBON_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
            carbonDioxideConcentration: { type: 'number', role: 'value.co2', unit: 'ppm' },
            display: { type: 'string', role: 'text' },
            humidity: { type: 'number', role: 'value.humidity', unit: '%' },
            setPointTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
            temperatureOffset: { type: 'number', role: 'value.temperature', unit: '°C' },
            vaporAmount: { type: 'number', role: 'value', unit: 'g/m³' },
        },
    },
    WATERING_ACTUATOR_CHANNEL: {
        states: {
            firstInputAction: { type: 'string', role: 'text' },
            profileMode: { type: 'string', role: 'text' },
            userDesiredProfileMode: { type: 'string', role: 'text' },
            waterFlow: { type: 'number', role: 'value', unit: 'l/min' },
            waterVolume: { type: 'number', role: 'value', unit: 'l' },
            waterVolumeSinceOpen: { type: 'number', role: 'value', unit: 'l' },
            wateringActive: { type: 'boolean', role: 'indicator' },
            wateringAmountTarget: { type: 'number', role: 'value', unit: 'l' },
            wateringOnTime: { type: 'number', role: 'value', unit: 's' },
        },
    },
    WATER_SUPPLY_STOP_CHANNEL: {
        states: {
            canbusSensorUsages: { type: 'string', role: 'json' },
            externalSensorMode: { type: 'string', role: 'text' },
            flushReminderInterval: { type: 'number', role: 'value' },
            lastFlushReminderTimestamp: { type: 'number', role: 'value.time' },
            lastFlushTimestamp: { type: 'number', role: 'value.time' },
            processing: { type: 'boolean', role: 'indicator' },
            vacationEndTime: { type: 'string', role: 'text' }, // ASSUMED
            vacationStartTime: { type: 'string', role: 'text' }, // ASSUMED
            waterAlarmActive: { type: 'boolean', role: 'indicator' },
            waterAlarmGroupId: { type: 'string', role: 'text' },
            waterFlow: { type: 'number', role: 'value', unit: 'l/min' },
            waterFlowDurationExceeded: { type: 'boolean', role: 'indicator' },
            waterFlowErrorDuration: { type: 'number', role: 'value' },
            waterFlowErrorDurationAction: { type: 'string', role: 'text' },
            waterFlowErrorThreshold: { type: 'number', role: 'value' },
            waterFlowErrorThresholdAction: { type: 'string', role: 'text' },
            waterFlowThresholdExceeded: { type: 'boolean', role: 'indicator' },
            waterPressure: { type: 'number', role: 'value.pressure', unit: 'bar' }, // ASSUMED
            waterSupplyState: { type: 'string', role: 'text' },
            waterSupplyVacationModeActive: { type: 'boolean', role: 'indicator' },
        },
    },
};

// channel types that carry no value of their own - listed so they are not reported as unknown

const STATELESS_CHANNELS = [
    'BLIND_GROUP_REMOTE_CONTROL_CHANNEL',
    'CODE_PROTECTED_SECONDARY_ACTION_CHANNEL',
    'INPUT_QUICK_ACTION_DISPLAY_CHANNEL',
];

/**
 * ioBroker object definitions for a table of states.
 *
 * @param {object} states field name -> {type, role, unit?}
 * @returns {{field: string, common: object}[]} one entry per state, ready for extendObject
 */
function channelStateObjects(states) {
    return Object.keys(states).map(field => ({
        field,
        common: { name: field, read: true, write: false, ...states[field] },
    }));
}

/**
 * Values for a table of states, read off one functional channel.
 *
 * A structured value has to be stringified here: it is declared as a json state, and the
 * adapter's state writer treats a raw object as an ioBroker state wrapper and would keep
 * only its `val`.
 *
 * @param {object} states field name -> {type, role, unit?}
 * @param {object} functionalChannel the channel as delivered by the cloud
 * @returns {{field: string, value: boolean|number|string|undefined}[]} one entry per state, ready for setState
 */
function channelStateValues(states, functionalChannel) {
    return Object.keys(states).map(field => {
        let value = functionalChannel ? functionalChannel[field] : undefined;
        if (states[field].role === 'json' && value !== undefined && value !== null) {
            value = JSON.stringify(value);
        }
        return { field, value };
    });
}

module.exports = {
    DEVICE_BASE_STATES,
    CHANNEL_STATES,
    STATELESS_CHANNELS,
    channelStateObjects,
    channelStateValues,
};
