'use strict';

/**
 * Read-only ioBroker states for functional channel types that the adapter maps generically.
 *
 * Field names and value types come from real payloads reported by the adapter's own
 * "Unknown Channel type" telemetry. A field that has only ever been observed as null is left
 * out on purpose: an ioBroker object keeps the type it was created with, so guessing one is
 * harder to undo than adding it later from a real sample.
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
            sabotageMagneticField: { type: 'boolean', role: 'indicator' },
            sabotageVertical: { type: 'boolean', role: 'indicator' },
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
            accessEventRegistrations: { type: 'string', role: 'json' },
            channelId: { type: 'string', role: 'text' },
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
            presenceMode: { type: 'string', role: 'text' },
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
    EXTERNAL_UNIVERSAL_LIGHT_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' },
            colorTemperature: { type: 'number', role: 'value.color.temperature', unit: 'K' },
            dimLevel: { type: 'number', role: 'value.brightness' },
            maximumColorTemperature: { type: 'number', role: 'value.color.temperature', unit: 'K' },
            minimalColorTemperature: { type: 'number', role: 'value.color.temperature', unit: 'K' },
            on: { type: 'boolean', role: 'indicator' },
        },
    },
    GENERIC_BATTERY_CHANNEL: {
        states: {
            batteryCapacity: { type: 'number', role: 'value', unit: 'Wh' },
            batteryLevel: { type: 'number', role: 'value.battery', unit: '%' },
            currentPowerConsumption: { type: 'number', role: 'value.power', unit: 'W' },
            energyCounterOne: { type: 'number', role: 'value.power.consumption', unit: 'kWh' },
            energyCounterOneType: { type: 'string', role: 'text' },
            energyCounterTwo: { type: 'number', role: 'value.power.consumption', unit: 'kWh' },
            energyCounterTwoType: { type: 'string', role: 'text' },
        },
    },
    GENERIC_CLIMATE_SENSOR_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
        },
    },
    GENERIC_ENERGY_METER_CHANNEL: {
        states: {
            currentPowerConsumption: { type: 'number', role: 'value.power', unit: 'W' },
            energyCounterOneType: { type: 'string', role: 'text' },
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
            particulateMassConcentrationOne: { type: 'number', role: 'value', unit: 'µg/m³' },
            particulateMassConcentrationTen: { type: 'number', role: 'value', unit: 'µg/m³' },
            particulateMassConcentrationTwoPointFive: { type: 'number', role: 'value', unit: 'µg/m³' },
        },
    },
    GENERIC_THERMOSTAT_CHANNEL: {
        states: {
            setPointTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
        },
    },
    GENERIC_WINDOW_COVERING_CHANNEL: {
        states: {
            shutterLevel: { type: 'number', role: 'value.blind' },
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
    TEMPERATURE_SENSOR_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
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
            waterAlarmActive: { type: 'boolean', role: 'indicator' },
            waterAlarmGroupId: { type: 'string', role: 'text' },
            waterFlow: { type: 'number', role: 'value', unit: 'l/min' },
            waterFlowDurationExceeded: { type: 'boolean', role: 'indicator' },
            waterFlowErrorDuration: { type: 'number', role: 'value' },
            waterFlowErrorDurationAction: { type: 'string', role: 'text' },
            waterFlowErrorThreshold: { type: 'number', role: 'value' },
            waterFlowErrorThresholdAction: { type: 'string', role: 'text' },
            waterFlowThresholdExceeded: { type: 'boolean', role: 'indicator' },
            waterSupplyState: { type: 'string', role: 'text' },
            waterSupplyVacationModeActive: { type: 'boolean', role: 'indicator' },
        },
    },
};

// channel types that carry no value of their own - listed so they are not reported as unknown

const STATELESS_CHANNELS = [
    'BLIND_GROUP_REMOTE_CONTROL_CHANNEL',
    'CODE_PROTECTED_SECONDARY_ACTION_CHANNEL',
    'GENERIC_CONTACT_SENSOR_CHANNEL',
    'GENERIC_SWITCH_INPUT_CHANNEL',
    'INDOOR_CLIMATE_DISPLAY_CHANNEL',
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
