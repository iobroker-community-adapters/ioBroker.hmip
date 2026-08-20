'use strict';

/**
 * Every ioBroker state the adapter derives from a device's functional channels.
 *
 * One entry per functionalChannelType. `extends` pulls in a base channel's states, `states`
 * lists the rest: `type` and `role` are the ioBroker object basics, and a state is read-only
 * unless it says otherwise. A writable state carries `parameter`, which is what _doStateChange
 * dispatches on, plus the `step` and `debounce` the write path needs.
 *
 * Values come from the field of the same name unless `from` names another, `derive` names a
 * function in DERIVERS, `constant` gives a fixed value, or `writeOnly` says nothing is ever
 * written back.
 *
 * Field names and types come from real device payloads - the adapter's own "Unknown Channel
 * type" telemetry, and the full logs reporters attached to issues. Where no payload has ever
 * carried a value the type is inferred from the name and marked ASSUMED, because an ioBroker
 * object keeps the type it was created with and a wrong one is harder to undo than a missing
 * state.
 */

const CHANNEL_STATES = {
    ACCELERATION_SENSOR_CHANNEL: {
        states: {
            accelerationSensorEventFilterPeriod: {
                type: 'number',
                role: 'level',
                write: true,
                parameter: 'setAccelerationSensorEventFilterPeriod',
            },
            accelerationSensorMode: {
                type: 'string',
                role: 'text',
                states: { ANY_MOTION: 'ANY_MOTION', FLAT_DECT: 'FLAT_DECT' },
                write: true,
                parameter: 'setAccelerationSensorMode',
            },
            accelerationSensorNeutralPosition: {
                type: 'string',
                role: 'text',
                states: { HORIZONTAL: 'HORIZONTAL', VERTICAL: 'VERTICAL' },
                write: true,
                parameter: 'setAccelerationSensorNeutralPosition',
            },
            accelerationSensorSensitivity: {
                type: 'string',
                role: 'text',
                states: {
                    SENSOR_RANGE_16G: 'SENSOR_RANGE_16G',
                    SENSOR_RANGE_8G: 'SENSOR_RANGE_8G',
                    SENSOR_RANGE_4G: 'SENSOR_RANGE_4G',
                    SENSOR_RANGE_2G: 'SENSOR_RANGE_2G',
                    SENSOR_RANGE_2G_PLUS_SENS: 'SENSOR_RANGE_2G_PLUS_SENS',
                    SENSOR_RANGE_2G_2PLUS_SENSE: 'SENSOR_RANGE_2G_2PLUS_SENSE',
                },
                write: true,
                parameter: 'setAccelerationSensorSensitivity',
            },
            accelerationSensorTriggerAngle: {
                type: 'number',
                role: 'level',
                write: true,
                parameter: 'setAccelerationSensorTriggerAngle',
            },
            accelerationSensorTriggered: { type: 'boolean', role: 'indicator' },
            notificationSoundTypeHighToLow: {
                type: 'string',
                role: 'text',
                states: {
                    SOUND_SHORT: 'SOUND_SHORT',
                    SOUND_LONG: 'SOUND_LONG',
                    SOUND_NO_SOUND: 'SOUND_NO_SOUND',
                    SOUND_SHORT_SHORT: 'SOUND_SHORT_SHORT',
                },
                write: true,
                parameter: 'setNotificationSoundType',
            },
            notificationSoundTypeLowToHigh: {
                type: 'string',
                role: 'text',
                states: {
                    SOUND_SHORT: 'SOUND_SHORT',
                    SOUND_LONG: 'SOUND_LONG',
                    SOUND_NO_SOUND: 'SOUND_NO_SOUND',
                    SOUND_SHORT_SHORT: 'SOUND_SHORT_SHORT',
                },
                write: true,
                parameter: 'setNotificationSoundType',
            },
        },
    },
    ACCESS_AUTHORIZATION_CHANNEL: {
        states: {
            authorized: { type: 'boolean', role: 'indicator' },
            pin: { type: 'string', role: 'state', write: true, writeOnly: true },
            pullLatch: {
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                parameter: 'pullLatch',
                constant: false,
            },
        },
    },
    ACCESS_CONTROLLER_CHANNEL: {
        extends: 'DEVICE_BASE',
        states: {
            accessPointPriority: { type: 'number', role: 'value' },
            carrierSenseLevel: { type: 'number', role: 'value' },
            dutyCycleLevel: { type: 'number', role: 'value' },
            signalBrightness: { type: 'number', role: 'value' },
        },
    },
    ACCESS_CONTROLLER_WIRED_CHANNEL: {
        extends: 'DEVICE_BASE',
        states: {
            accessPointPriority: { type: 'number', role: 'value' },
            busConfigMismatch: { type: 'boolean', role: 'indicator' },
            busMode: { type: 'string', role: 'text' },
            powerShortCircuit: { type: 'string', role: 'text' },
            powerSupplyCurrent: { type: 'number', role: 'value' },
            shortCircuitDataLine: { type: 'string', role: 'text' },
            signalBrightness: { type: 'number', role: 'value' },
        },
    },
    AIR_PRESSURE_SENSOR_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
            airPressure: { type: 'number', role: 'value.pressure', unit: 'hPa' },
        },
    },
    ALARM_SIREN_CHANNEL: {
        states: {
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
        },
    },
    ANALOG_OUTPUT_CHANNEL: {
        states: {
            analogOutputLevel: { type: 'number', role: 'value' },
        },
    },
    ANALOG_ROOM_CONTROL_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
            setPointTemperature: {
                type: 'number',
                role: 'level.temperature',
                unit: '°C',
                write: true,
                parameter: 'setPointTemperature',
                step: 0.5,
                debounce: 5000,
                targetGroups: true,
            },
            temperatureOffset: { type: 'number', role: 'value', unit: '°C' },
        },
    },
    BACKLIGHT_CHANNEL: {
        states: {
            controlOnTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            controlRampTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            dimLevel: { type: 'number', role: 'level.dimmer', min: 0, max: 1, write: true, parameter: 'setDimLevel' },
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
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
    BLIND_CHANNEL: {
        states: {
            blindModeActive: { type: 'boolean', role: 'indicator' },
            bottomToTopReferenceTime: { type: 'number', role: 'value.interval' },
            changeOverDelay: { type: 'number', role: 'value.interval' },
            delayCompensationValue: { type: 'number', role: 'value.interval' },
            endpositionAutoDetectionEnabled: { type: 'boolean', role: 'indicator' },
            previousShutterLevel: { type: 'number', role: 'value' },
            previousSlatsLevel: { type: 'string', role: 'text' },
            processing: { type: 'boolean', role: 'indicator' },
            profileMode: { type: 'string', role: 'text', states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' } },
            selfCalibrationInProgress: { type: 'boolean', role: 'indicator' },
            shutterLevel: {
                type: 'number',
                role: 'level.blind',
                min: 0,
                max: 100,
                write: true,
                parameter: 'shutterlevel',
                derive: 'percent',
            },
            slatsLevel: {
                type: 'number',
                role: 'level.blind',
                min: 0,
                max: 100,
                write: true,
                parameter: 'slatsLevel',
                derive: 'percent',
            },
            slatsReferenceTime: { type: 'number', role: 'value.interval' },
            stop: { type: 'boolean', role: 'button', read: false, write: true, parameter: 'stop', writeOnly: true },
            supportingDelayCompensation: { type: 'boolean', role: 'indicator' },
            supportingEndpositionAutoDetection: { type: 'boolean', role: 'indicator' },
            supportingSelfCalibration: { type: 'boolean', role: 'indicator' },
            topToBottomReferenceTime: { type: 'number', role: 'value.interval' },
            userDesiredProfileMode: {
                type: 'string',
                role: 'text',
                states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' },
            },
        },
    },
    CARBON_DIOXIDE_SENSOR_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
            carbonDioxideConcentration: { type: 'number', role: 'value' },
            carbonDioxideVisualisationEnabled: { type: 'boolean', role: 'indicator' },
            humidity: { type: 'number', role: 'value.humidity', unit: '%' },
            vaporAmount: { type: 'number', role: 'level' },
        },
    },
    CLIMATE_SENSOR_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
            humidity: { type: 'number', role: 'value.humidity', unit: '%' },
            vaporAmount: { type: 'number', role: 'level' },
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
    CONTACT_INTERFACE_CHANNEL: {
        extends: 'DEVICE_BASE',
        states: {
            alarmContactType: { type: 'string', role: 'text' },
            contactType: { type: 'string', role: 'text' },
            eventDelay: { type: 'number', role: 'value' },
            windowOpen: { type: 'boolean', role: 'indicator', derive: 'windowOpen' },
            windowState: { type: 'string', role: 'sensor.window' },
        },
    },
    DEVICE_BASE: {
        states: {
            bootedRecently: { type: 'boolean', role: 'indicator' },
            coProFaulty: { type: 'boolean', role: 'indicator' },
            coProRestartNeeded: { type: 'boolean', role: 'indicator' },
            coProUpdateFailure: { type: 'boolean', role: 'indicator' },
            configPending: { type: 'boolean', role: 'indicator' },
            deviceOverheated: { type: 'boolean', role: 'indicator' },
            deviceOverloaded: { type: 'boolean', role: 'indicator' },
            devicePowerFailureDetected: { type: 'boolean', role: 'indicator' },
            deviceUndervoltage: { type: 'boolean', role: 'indicator' },
            dutyCycle: { type: 'boolean', role: 'indicator' },
            lastBootTimestamp: { type: 'number', role: 'value.time' },
            lowBat: { type: 'boolean', role: 'indicator.maintenance.lowbat' },
            multicastRoutingEnabled: { type: 'boolean', role: 'indicator' },
            profilePeriodLimitReached: { type: 'boolean', role: 'indicator' },
            routerModuleEnabled: { type: 'boolean', role: 'switch', write: true, parameter: 'setRouterModuleEnabled' },
            routerModuleSupported: { type: 'boolean', role: 'indicator' },
            rssiDeviceValue: { type: 'number', role: 'value' },
            rssiPeerValue: { type: 'number', role: 'value' },
            temperatureOutOfRange: { type: 'boolean', role: 'indicator' },
            unreach: { type: 'boolean', role: 'indicator' },
        },
    },
    DEVICE_BASE_FLOOR_HEATING: {
        extends: 'DEVICE_BASE',
        states: {
            coolingEmergencyValue: { type: 'number', role: 'value' },
            frostProtectionTemperature: { type: 'number', role: 'value' },
            heatingEmergencyValue: { type: 'number', role: 'value' },
            minimumFloorHeatingValvePosition: {
                type: 'number',
                role: 'level',
                min: 0,
                max: 100,
                write: true,
                parameter: 'setMinimumFloorHeatingValvePosition',
                derive: 'percent',
            },
            pulseWidthModulationAtLowFloorHeatingValvePositionEnabled: { type: 'boolean', role: 'indicator' },
            valveProtectionDuration: { type: 'number', role: 'value' },
            valveProtectionSwitchingInterval: { type: 'number', role: 'value' },
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
    DEVICE_GLOBAL_PUMP_CONTROL: {
        extends: 'DEVICE_BASE',
        states: {
            coolingEmergencyValue: { type: 'number', role: 'value' },
            frostProtectionTemperature: { type: 'number', role: 'value' },
            globalPumpControl: { type: 'boolean', role: 'indicator' },
            heatingEmergencyValue: { type: 'number', role: 'value' },
            heatingLoadType: {
                type: 'string',
                role: 'text',
                states: { LOAD_BALANCING: 'LOAD_BALANCING', LOAD_COLLECTION: 'LOAD_COLLECTION' },
            },
            heatingValveType: {
                type: 'string',
                role: 'text',
                states: { NORMALLY_CLOSE: 'NORMALLY_CLOSE', NORMALLY_OPEN: 'NORMALLY_OPEN' },
            },
            valveProtectionDuration: { type: 'number', role: 'value' },
            valveProtectionSwitchingInterval: { type: 'number', role: 'value' },
        },
    },
    DEVICE_INCORRECT_POSITIONED: {
        extends: 'DEVICE_BASE',
        states: {
            incorrectPositioned: { type: 'boolean', role: 'indicator' },
        },
    },
    DEVICE_OPERATIONLOCK: {
        states: {
            bootedRecently: { type: 'boolean', role: 'indicator' },
            coProFaulty: { type: 'boolean', role: 'indicator' },
            coProRestartNeeded: { type: 'boolean', role: 'indicator' },
            coProUpdateFailure: { type: 'boolean', role: 'indicator' },
            configPending: { type: 'boolean', role: 'indicator' },
            deviceOverheated: { type: 'boolean', role: 'indicator' },
            deviceOverloaded: { type: 'boolean', role: 'indicator' },
            devicePowerFailureDetected: { type: 'boolean', role: 'indicator' },
            deviceUndervoltage: { type: 'boolean', role: 'indicator' },
            dutyCycle: { type: 'boolean', role: 'indicator' },
            lastBootTimestamp: { type: 'number', role: 'value.time' },
            lowBat: { type: 'boolean', role: 'indicator.maintenance.lowbat' },
            multicastRoutingEnabled: { type: 'boolean', role: 'indicator' },
            operationLockActive: { type: 'boolean', role: 'switch', write: true, parameter: 'setOperationLock' },
            profilePeriodLimitReached: { type: 'boolean', role: 'indicator' },
            routerModuleEnabled: { type: 'boolean', role: 'switch', write: true, parameter: 'setRouterModuleEnabled' },
            routerModuleSupported: { type: 'boolean', role: 'indicator' },
            rssiDeviceValue: { type: 'number', role: 'value' },
            rssiPeerValue: { type: 'number', role: 'value' },
            temperatureOutOfRange: { type: 'boolean', role: 'indicator' },
            unreach: { type: 'boolean', role: 'indicator' },
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
    DEVICE_PERMANENT_FULL_RX: {
        extends: 'DEVICE_BASE',
        states: {
            permanentFullRx: { type: 'boolean', role: 'indicator' },
        },
    },
    DEVICE_RECHARGEABLE_WITH_SABOTAGE: {
        extends: 'DEVICE_BASE',
        states: {
            badBatteryHealth: { type: 'boolean', role: 'indicator' },
            sabotage: { type: 'boolean', role: 'indicator.alarm' },
        },
    },
    DEVICE_SABOTAGE: {
        extends: 'DEVICE_BASE',
        states: {
            sabotage: { type: 'boolean', role: 'indicator.alarm' },
        },
    },
    DIMMER_CHANNEL: {
        states: {
            controlOnTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            controlRampTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            dimLevel: {
                type: 'number',
                role: 'level.dimmer',
                min: 0,
                max: 100,
                write: true,
                parameter: 'setDimLevel',
                derive: 'percent',
            },
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
            profileMode: { type: 'string', role: 'text', states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' } },
            userDesiredProfileMode: {
                type: 'string',
                role: 'text',
                states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' },
            },
        },
    },
    DOOR_CHANNEL: {
        states: {
            doorCommand: {
                type: 'number',
                role: 'value',
                states: { 0: 'OPEN', 1: 'STOP', 2: 'CLOSE', 3: 'VENTILATION_POSITION' },
                write: true,
                parameter: 'sendDoorCommand',
                constant: null,
            },
            doorState: { type: 'string', role: 'info' },
            on: { type: 'boolean', role: 'info' },
            processing: { type: 'boolean', role: 'info' },
            ventilationPositionSupported: { type: 'boolean', role: 'info' },
        },
    },
    DOOR_LOCK_CHANNEL: {
        states: {
            autoRelockDelay: { type: 'number', role: 'value.interval' },
            autoRelockEnabled: { type: 'boolean', role: 'info' },
            doorHandleType: { type: 'string', role: 'info' },
            doorLockDirection: { type: 'string', role: 'info' },
            doorLockNeutralPosition: { type: 'string', role: 'info' },
            doorLockTurns: { type: 'number', role: 'value' },
            lockState: {
                type: 'string',
                role: 'info',
                states: { OPEN: 'OPEN', UNLOCKED: 'UNLOCKED', LOCKED: 'LOCKED', NONE: 'NONE' },
            },
            motorState: {
                type: 'string',
                role: 'info',
                states: { STOPPED: 'STOPPED', CLOSING: 'CLOSING', OPENING: 'OPENING' },
            },
            pin: { type: 'string', role: 'state', write: true, writeOnly: true },
            setLockState: {
                type: 'number',
                role: 'value',
                states: { 1: 'OPEN', 2: 'LOCKED', 3: 'UNLOCKED' },
                write: true,
                parameter: 'setLockState',
                constant: null,
            },
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
            pin: { type: 'string', role: 'state', write: true, writeOnly: true },
            sabotageAcceleration: { type: 'boolean', role: 'indicator' },
            sabotageAccelerationAcknowledged: { type: 'boolean', role: 'indicator' },
            sabotageBattery: { type: 'boolean', role: 'indicator' },
            sabotageBatteryAcknowledged: { type: 'boolean', role: 'indicator' }, // ASSUMED
            sabotageMagneticField: { type: 'boolean', role: 'indicator' },
            sabotageMagneticFieldAcknowledged: { type: 'boolean', role: 'indicator' }, // ASSUMED
            sabotageVertical: { type: 'boolean', role: 'indicator' },
            sabotageVerticalAcknowledged: { type: 'boolean', role: 'indicator' }, // ASSUMED
            setLockState: {
                type: 'number',
                role: 'value',
                states: { 1: 'OPEN', 2: 'LOCKED', 3: 'UNLOCKED' },
                write: true,
                parameter: 'setLockState',
                constant: null,
            },
        },
    },
    DOOR_LOCK_SENSOR_BASE_CHANNEL: {
        states: {
            lockState: { type: 'string', role: 'text' },
        },
    },
    DOOR_LOCK_SENSOR_CHANNEL: {
        states: {
            doorLockDirection: { type: 'string', role: 'info' },
            doorLockNeutralPosition: { type: 'string', role: 'info' },
            doorLockTurns: { type: 'number', role: 'value' },
            lockState: {
                type: 'string',
                role: 'info',
                states: { OPEN: 'OPEN', UNLOCKED: 'UNLOCKED', LOCKED: 'LOCKED', NONE: 'NONE' },
            },
        },
    },
    DOOR_SWITCH_CHANNEL: {
        states: {
            doorLockActive: { type: 'boolean', role: 'indicator' },
            impulseDuration: { type: 'number', role: 'value', unit: 's' },
            multiModeInputMode: { type: 'string', role: 'text' },
            processing: { type: 'boolean', role: 'indicator' },
            profileMode: { type: 'string', role: 'text' },
            startImpulse: {
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                parameter: 'startImpulse',
                constant: false,
            },
            userDesiredProfileMode: { type: 'string', role: 'text' },
        },
    },
    ENERGY_SENSORS_INTERFACE_CHANNEL: {
        states: {
            connectedEnergySensorType: { type: 'string', role: 'info' },
            currentGasFlow: { type: 'number', role: 'value' },
            currentPowerConsumption: { type: 'number', role: 'value' },
            energyCounterOne: { type: 'number', role: 'value' },
            energyCounterOneType: { type: 'string', role: 'info' },
            energyCounterThree: { type: 'number', role: 'value' },
            energyCounterThreeType: { type: 'string', role: 'info' },
            energyCounterTwo: { type: 'number', role: 'value' },
            energyCounterTwoType: { type: 'string', role: 'info' },
            gasVolume: { type: 'number', role: 'value' },
            gasVolumePerImpulse: { type: 'number', role: 'value' },
            impulsesPerKWH: { type: 'number', role: 'value' },
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
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
            switchVisualization: { type: 'string', role: 'text' },
        },
    },
    EXTERNAL_UNIVERSAL_LIGHT_CHANNEL: {
        states: {
            channelId: { type: 'string', role: 'text' },
            colorTemperature: { type: 'number', role: 'value.color.temperature', unit: 'K' },
            controlOnTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            controlRampTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            dimLevel: { type: 'number', role: 'level.dimmer', min: 0, max: 1, write: true, parameter: 'setDimLevel' },
            hue: { type: 'number', role: 'value' },
            maximumColorTemperature: { type: 'number', role: 'value.color.temperature', unit: 'K' },
            minimalColorTemperature: { type: 'number', role: 'value.color.temperature', unit: 'K' },
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
            saturationLevel: { type: 'number', role: 'value' },
            switchVisualization: { type: 'string', role: 'text' },
        },
    },
    FLOOR_TERMINAL_BLOCK_LOCAL_PUMP_CHANNEL: {
        states: {
            pumpFollowUpTime: { type: 'number', role: 'value' },
            pumpLeadTime: { type: 'number', role: 'value' },
            pumpProtectionDuration: { type: 'number', role: 'value' },
            pumpProtectionSwitchingInterval: { type: 'number', role: 'value' },
        },
    },
    FLOOR_TERMINAL_BLOCK_MECHANIC_CHANNEL: {
        states: {
            valvePosition: { type: 'number', role: 'valve', unit: '%', derive: 'percent' },
            valveState: { type: 'string', role: 'text' },
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
    GENERIC_INPUT_CHANNEL: {
        states: {
            digitalInputMode: { type: 'string', role: 'text' },
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
            shutterLevel: {
                type: 'number',
                role: 'level.blind',
                min: 0,
                max: 1,
                write: true,
                parameter: 'shutterlevel',
            },
            slatsLevel: { type: 'number', role: 'level.blind', min: 0, max: 1, write: true, parameter: 'slatsLevel' }, // ASSUMED
        },
    },
    HEATING_THERMOSTAT_CHANNEL: {
        states: {
            setPointTemperature: {
                type: 'number',
                role: 'level.temperature',
                unit: '°C',
                write: true,
                parameter: 'setPointTemperature',
                step: 0.5,
                debounce: 5000,
                targetGroups: true,
            },
            temperatureOffset: { type: 'number', role: 'value', unit: '°C' },
            valveActualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
            valvePosition: { type: 'number', role: 'value' },
            valveState: { type: 'string', role: 'text' },
        },
    },
    IMPULSE_OUTPUT_CHANNEL: {
        states: {
            impulseDuration: { type: 'number', role: 'value' },
            processing: { type: 'boolean', role: 'indicator.working' },
            startImpulse: {
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                parameter: 'startImpulse',
                constant: false,
            },
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
    INTERNAL_SWITCH_CHANNEL: {
        states: {
            frostProtectionTemperature: { type: 'number', role: 'value' },
            heatingValveType: { type: 'string', role: 'text' },
            internalSwitchOutputEnabled: { type: 'boolean', role: 'indicator' },
            valveProtectionDuration: { type: 'number', role: 'value' },
            valveProtectionSwitchingInterval: { type: 'number', role: 'value' },
        },
    },
    LIGHT_SENSOR_CHANNEL: {
        states: {
            averageIllumination: { type: 'number', role: 'value' },
            currentIllumination: { type: 'number', role: 'value' },
            highestIllumination: { type: 'number', role: 'value' },
            lowestIllumination: { type: 'number', role: 'value' },
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
    MAINS_FAILURE_CHANNEL: {
        states: {
            genericAlarmSignal: {
                type: 'string',
                role: 'info',
                states: { NO_ALARM: 'NO_ALARM', SILENT_ALARM: 'SILENT_ALARM', FULL_ALARM: 'FULL_ALARM' },
            },
            powerMainsFailure: { type: 'boolean', role: 'indicator' },
        },
    },
    MOTION_DETECTION_CHANNEL: {
        states: {
            currentIllumination: { type: 'number', role: 'value' },
            illumination: { type: 'number', role: 'value' },
            motionBufferActive: { type: 'boolean', role: 'switch', read: false },
            motionDetected: { type: 'boolean', role: 'indicator' },
            motionDetectionActive: {
                type: 'boolean',
                role: 'switch',
                write: true,
                parameter: 'setMotionDetectionActive',
            },
            motionDetectionSendInterval: {
                type: 'string',
                role: 'text',
                states: {
                    SECONDS_30: 'SECONDS_30',
                    SECONDS_60: 'SECONDS_60',
                    SECONDS_120: 'SECONDS_120',
                    SECONDS_240: 'SECONDS_240',
                    SECONDS_480: 'SECONDS_480',
                },
                read: false,
            },
            numberOfBrightnessMeasurements: { type: 'number', role: 'value' },
        },
    },
    MULTI_MODE_INPUT_BLIND_CHANNEL: {
        states: {
            binaryBehaviorType: { type: 'string', role: 'value' },
            blindModeActive: { type: 'boolean', role: 'indicator' },
            bottomToTopReferenceTime: { type: 'number', role: 'value.interval' },
            changeOverDelay: { type: 'number', role: 'value.interval' },
            delayCompensationValue: { type: 'number', role: 'value.interval' },
            endpositionAutoDetectionEnabled: { type: 'boolean', role: 'indicator' },
            favoritePrimaryShadingPosition: { type: 'number', role: 'level' },
            favoriteSecondaryShadingPosition: { type: 'number', role: 'level' },
            multiModeInputMode: { type: 'string', role: 'value' },
            previousShutterLevel: { type: 'number', role: 'value' },
            previousSlatsLevel: { type: 'string', role: 'text' },
            processing: { type: 'boolean', role: 'indicator' },
            profileMode: { type: 'string', role: 'text', states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' } },
            selfCalibrationInProgress: { type: 'boolean', role: 'indicator' },
            shutterLevel: {
                type: 'number',
                role: 'level.blind',
                min: 0,
                max: 100,
                write: true,
                parameter: 'shutterlevel',
                derive: 'percent',
            },
            slatsLevel: {
                type: 'number',
                role: 'level.blind',
                min: 0,
                max: 100,
                write: true,
                parameter: 'slatsLevel',
                derive: 'percent',
            },
            slatsReferenceTime: { type: 'number', role: 'value.interval' },
            stop: { type: 'boolean', role: 'button', read: false, write: true, parameter: 'stop', writeOnly: true },
            supportingDelayCompensation: { type: 'boolean', role: 'indicator' },
            supportingEndpositionAutoDetection: { type: 'boolean', role: 'indicator' },
            supportingSelfCalibration: { type: 'boolean', role: 'indicator' },
            topToBottomReferenceTime: { type: 'number', role: 'value.interval' },
            userDesiredProfileMode: {
                type: 'string',
                role: 'text',
                states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' },
            },
        },
    },
    MULTI_MODE_INPUT_CHANNEL: {
        states: {
            binaryBehaviorType: {
                type: 'string',
                role: 'text',
                states: { NORMALLY_CLOSE: 'NORMALLY_CLOSE', NORMALLY_OPEN: 'NORMALLY_OPEN' },
            },
            corrosionPreventionActive: { type: 'boolean', role: 'indicator' },
            doorBellSensorEventTimestamp: { type: 'number', role: 'date' },
            multiModeInputMode: {
                type: 'string',
                role: 'text',
                states: {
                    KEY_BEHAVIOR: 'KEY_BEHAVIOR',
                    SWITCH_BEHAVIOR: 'SWITCH_BEHAVIOR',
                    BINARY_BEHAVIOR: 'BINARY_BEHAVIOR',
                },
            },
            windowOpen: { type: 'boolean', role: 'indicator', derive: 'windowOpen' },
            windowState: { type: 'string', role: 'text' },
        },
    },
    MULTI_MODE_INPUT_DIMMER_CHANNEL: {
        states: {
            binaryBehaviorType: {
                type: 'string',
                role: 'text',
                states: { NORMALLY_CLOSE: 'NORMALLY_CLOSE', NORMALLY_OPEN: 'NORMALLY_OPEN' },
            },
            controlOnTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            controlRampTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            dimLevel: {
                type: 'number',
                role: 'level.dimmer',
                min: 0,
                max: 100,
                write: true,
                parameter: 'setDimLevel',
                derive: 'percent',
            },
            multiModeInputMode: {
                type: 'string',
                role: 'text',
                states: {
                    KEY_BEHAVIOR: 'KEY_BEHAVIOR',
                    SWITCH_BEHAVIOR: 'SWITCH_BEHAVIOR',
                    BINARY_BEHAVIOR: 'BINARY_BEHAVIOR',
                },
            },
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
            powerUpSwitchState: { type: 'string', role: 'state' },
            profileMode: { type: 'string', role: 'text', states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' } },
            userDesiredProfileMode: {
                type: 'string',
                role: 'state',
                states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' },
            },
        },
    },
    MULTI_MODE_INPUT_SWITCH_CHANNEL: {
        states: {
            binaryBehaviorType: {
                type: 'string',
                role: 'text',
                states: { NORMALLY_CLOSE: 'NORMALLY_CLOSE', NORMALLY_OPEN: 'NORMALLY_OPEN' },
            },
            multiModeInputMode: {
                type: 'string',
                role: 'text',
                states: {
                    KEY_BEHAVIOR: 'KEY_BEHAVIOR',
                    SWITCH_BEHAVIOR: 'SWITCH_BEHAVIOR',
                    BINARY_BEHAVIOR: 'BINARY_BEHAVIOR',
                },
            },
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
            powerUpSwitchState: { type: 'string', role: 'state' },
            profileMode: { type: 'string', role: 'text', states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' } },
            userDesiredProfileMode: {
                type: 'string',
                role: 'state',
                states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' },
            },
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
    NOTIFICATION_LIGHT_CHANNEL: {
        states: {
            controlOnTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            controlRampTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            dimLevel: { type: 'number', role: 'level.dimmer', write: true, parameter: 'setRgbDimLevel' },
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
            opticalSignalBehaviour: {
                type: 'string',
                role: 'state',
                states: {
                    ON: 'ON',
                    BLINKING_MIDDLE: 'BLINKING_MIDDLE',
                    FLASH_MIDDLE: 'FLASH_MIDDLE',
                    BILLOW_MIDDLE: 'BILLOW_MIDDLE',
                },
                write: true,
                parameter: 'setOpticalSignalBehaviour',
            },
            simpleRGBColorState: { type: 'string', role: 'text', write: true, parameter: 'setRgbDimLevel' },
        },
    },
    NOTIFICATION_MP3_SOUND_CHANNEL: {
        states: {
            profileMode: { type: 'string', role: 'text', states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' } },
            soundFile: { type: 'string', role: 'text', write: true, parameter: 'setSoundFileVolumeLevel' },
            userDesiredProfileMode: {
                type: 'string',
                role: 'text',
                states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' },
            },
            volumeLevel: { type: 'number', role: 'level.volume', write: true, parameter: 'setSoundFileVolumeLevel' },
        },
    },
    OPTICAL_SIGNAL_CHANNEL: {
        states: {
            controlOnTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            controlRampTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            dimLevel: {
                type: 'number',
                role: 'level.dimmer',
                min: 0,
                max: 1,
                write: true,
                parameter: 'setRgbDimLevel',
            },
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
            onMinLevel: { type: 'number', role: 'value' },
            opticalSignalBehaviour: {
                type: 'string',
                role: 'text',
                write: true,
                parameter: 'setOpticalSignalBehaviour',
            },
            powerUpDimLevel: { type: 'number', role: 'value' },
            powerUpOpticalSignalBehaviour: { type: 'string', role: 'text' },
            powerUpSimpleRGBColor: { type: 'string', role: 'text' },
            powerUpSwitchState: { type: 'string', role: 'text' },
            simpleRGBColorState: { type: 'string', role: 'text', write: true, parameter: 'setRgbDimLevel' },
            switchVisualization: { type: 'string', role: 'text' },
            userDesiredProfileMode: { type: 'string', role: 'text' },
        },
    },
    OPTICAL_SIGNAL_GROUP_CHANNEL: {
        states: {
            controlOnTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            controlRampTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            dimLevel: {
                type: 'number',
                role: 'level.dimmer',
                min: 0,
                max: 1,
                write: true,
                parameter: 'setRgbDimLevel',
            },
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
            onMinLevel: { type: 'number', role: 'value' },
            opticalSignalBehaviour: {
                type: 'string',
                role: 'text',
                write: true,
                parameter: 'setOpticalSignalBehaviour',
            },
            powerUpDimLevel: { type: 'number', role: 'value' },
            powerUpOpticalSignalBehaviour: { type: 'string', role: 'text' },
            powerUpSimpleRGBColor: { type: 'string', role: 'text' },
            powerUpSwitchState: { type: 'string', role: 'text' },
            simpleRGBColorState: { type: 'string', role: 'text', write: true, parameter: 'setRgbDimLevel' },
            switchVisualization: { type: 'string', role: 'text' },
            userDesiredProfileMode: { type: 'string', role: 'text' },
        },
    },
    PARTICULATE_MATTER_SENSOR_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature' },
            airQualityIndexTen: { type: 'number', role: 'value' },
            airQualityIndexTwoPointFive: { type: 'number', role: 'value' },
            humidity: { type: 'number', role: 'value.humidity' },
            particulateMassConcentrationOne: { type: 'number', role: 'value' },
            particulateMassConcentrationOneAverage: { type: 'number', role: 'value' },
            particulateMassConcentrationTen: { type: 'number', role: 'value' },
            particulateMassConcentrationTenAverage: { type: 'number', role: 'value' },
            particulateMassConcentrationTwoPointFive: { type: 'number', role: 'value' },
            particulateMassConcentrationTwoPointFiveAverage: { type: 'number', role: 'value' },
            particulateNumberConcentrationOne: { type: 'number', role: 'value' },
            particulateNumberConcentrationTen: { type: 'number', role: 'value' },
            particulateNumberConcentrationTwoPointFive: { type: 'number', role: 'value' },
            particulateTypicalSize: { type: 'number', role: 'value' },
        },
    },
    PASSAGE_DETECTOR_CHANNEL: {
        extends: 'DEVICE_BASE',
        states: {
            leftCounter: { type: 'number', role: 'value' },
            leftRightCounterDelta: { type: 'number', role: 'value' },
            passageBlindtime: { type: 'number', role: 'value' },
            passageDirection: { type: 'string', role: 'text', states: { LEFT: 'LEFT', RIGHT: 'RIGHT' } },
            passageSensorSensitivity: { type: 'number', role: 'value' },
            passageTimeout: { type: 'number', role: 'value' },
            resetPassageCounter: {
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                parameter: 'resetPassageCounter',
                constant: false,
            },
            rightCounter: { type: 'number', role: 'value' },
        },
    },
    PRESENCE_DETECTION_CHANNEL: {
        extends: 'DEVICE_BASE',
        states: {
            currentIllumination: { type: 'number', role: 'value' },
            illumination: { type: 'number', role: 'value' },
            motionBufferActive: { type: 'boolean', role: 'indicator' },
            motionDetectionActive: {
                type: 'boolean',
                role: 'switch',
                write: true,
                parameter: 'setMotionDetectionActive',
            },
            motionDetectionSendInterval: {
                type: 'string',
                role: 'text',
                states: {
                    SECONDS_30: 'SECONDS_30',
                    SECONDS_60: 'SECONDS_60',
                    SECONDS_120: 'SECONDS_120',
                    SECONDS_240: 'SECONDS_240',
                    SECONDS_480: 'SECONDS_480',
                },
            },
            numberOfBrightnessMeasurements: { type: 'number', role: 'value' },
            presenceDetected: { type: 'boolean', role: 'indicator' },
        },
    },
    RAIN_DETECTION_CHANNEL: {
        states: {
            rainSensorSensitivity: { type: 'number', role: 'value' },
            raining: { type: 'boolean', role: 'sensor.rain' },
        },
    },
    ROTARY_HANDLE_CHANNEL: {
        states: {
            eventDelay: { type: 'number', role: 'value' },
            windowOpen: { type: 'boolean', role: 'indicator', derive: 'windowOpen' },
            windowState: { type: 'string', role: 'text' },
        },
    },
    ROTARY_WHEEL_CHANNEL: {
        states: {
            rotationDirection: { type: 'string', role: 'text' },
        },
    },
    SHADING_CHANNEL: {
        states: {
            automationDriveSpeed: {
                type: 'string',
                role: 'text',
                states: {
                    CREEP_SPEED: 'CREEP_SPEED',
                    SLOW_SPEED: 'SLOW_SPEED',
                    NOMINAL_SPEED: 'NOMINAL_SPEED',
                    OPTIONAL_SPEED: 'OPTIONAL_SPEED',
                },
            },
            favoritePrimaryShadingPosition: { type: 'number', role: 'value', unit: '%' },
            favoriteSecondaryShadingPosition: { type: 'number', role: 'value', unit: '%' },
            identifyOemSupported: { type: 'boolean', role: 'indicator' },
            manualDriveSpeed: {
                type: 'string',
                role: 'text',
                states: {
                    CREEP_SPEED: 'CREEP_SPEED',
                    SLOW_SPEED: 'SLOW_SPEED',
                    NOMINAL_SPEED: 'NOMINAL_SPEED',
                    OPTIONAL_SPEED: 'OPTIONAL_SPEED',
                },
            },
            previousPrimaryShadingLevel: { type: 'number', role: 'value', unit: '%' },
            previousSecondaryShadingLevel: { type: 'number', role: 'value', unit: '%' },
            primaryCloseAdjustable: { type: 'boolean', role: 'indicator' },
            primaryOpenAdjustable: { type: 'boolean', role: 'indicator' },
            primaryShadingLevel: {
                type: 'number',
                role: 'level.blind',
                unit: '%',
                min: 0,
                max: 100,
                write: true,
                parameter: 'setPrimaryShadingLevel',
                derive: 'percent',
            },
            primaryShadingStateType: {
                type: 'string',
                role: 'text',
                states: {
                    NOT_POSSIBLE: 'NOT_POSSIBLE',
                    NOT_EXISTENT: 'NOT_EXISTENT',
                    POSITION_USED: 'POSITION_USED',
                    TILT_USED: 'TILT_USED',
                    NOT_USED: 'NOT_USED',
                    MIXED: 'MIXED',
                },
            },
            processing: { type: 'boolean', role: 'indicator' },
            productId: { type: 'number', role: 'value' },
            profileMode: { type: 'string', role: 'text', states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' } },
            secondaryCloseAdjustable: { type: 'boolean', role: 'indicator' },
            secondaryOpenAdjustable: { type: 'boolean', role: 'indicator' },
            secondaryShadingLevel: {
                type: 'number',
                role: 'level.blind',
                unit: '%',
                min: 0,
                max: 100,
                write: true,
                parameter: 'setSecondaryShadingLevel',
                derive: 'percent',
            },
            secondaryShadingStateType: {
                type: 'string',
                role: 'text',
                states: {
                    NOT_POSSIBLE: 'NOT_POSSIBLE',
                    NOT_EXISTENT: 'NOT_EXISTENT',
                    POSITION_USED: 'POSITION_USED',
                    TILT_USED: 'TILT_USED',
                    NOT_USED: 'NOT_USED',
                    MIXED: 'MIXED',
                },
            },
            setFavoriteShadingPosition: {
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                parameter: 'setFavoriteShadingPosition',
                constant: false,
            },
            shadingDriveVersion: { type: 'number', role: 'value' },
            shadingPackagePosition: {
                type: 'string',
                role: 'text',
                states: {
                    LEFT: 'LEFT',
                    RIGHT: 'RIGHT',
                    CENTER: 'CENTER',
                    SPLIT: 'SPLIT',
                    TOP: 'TOP',
                    BOTTOM: 'BOTTOM',
                    TDBU: 'TDBU',
                    NOT_USED: 'NOT_USED',
                },
            },
            shadingPositionAdjustmentActive: { type: 'boolean', role: 'indicator' },
            shadingPositionAdjustmentClientId: { type: 'string', role: 'text' },
            userDesiredProfileMode: {
                type: 'string',
                role: 'text',
                states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' },
            },
        },
    },
    SHUTTER_CHANNEL: {
        states: {
            bottomToTopReferenceTime: { type: 'number', role: 'value.interval' },
            changeOverDelay: { type: 'number', role: 'value.interval' },
            delayCompensationValue: { type: 'number', role: 'value.interval' },
            endpositionAutoDetectionEnabled: { type: 'boolean', role: 'indicator' },
            previousShutterLevel: { type: 'number', role: 'value' },
            processing: { type: 'boolean', role: 'text' },
            profileMode: { type: 'string', role: 'text', states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' } },
            selfCalibrationInProgress: { type: 'boolean', role: 'indicator' },
            shutterLevel: {
                type: 'number',
                role: 'level',
                min: 0,
                max: 100,
                write: true,
                parameter: 'shutterlevel',
                derive: 'percent',
            },
            stop: { type: 'boolean', role: 'button', read: false, write: true, parameter: 'stop', writeOnly: true },
            supportingDelayCompensation: { type: 'boolean', role: 'indicator' },
            supportingEndpositionAutoDetection: { type: 'boolean', role: 'indicator' },
            supportingSelfCalibration: { type: 'boolean', role: 'indicator' },
            topToBottomReferenceTime: { type: 'number', role: 'value.interval' },
            userDesiredProfileMode: {
                type: 'string',
                role: 'text',
                states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' },
            },
        },
    },
    SHUTTER_CONTACT_CHANNEL: {
        states: {
            eventDelay: { type: 'number', role: 'value' },
            windowOpen: { type: 'boolean', role: 'sensor.window', derive: 'windowOpen' },
            windowState: { type: 'string', role: 'sensor.window' },
        },
    },
    SINGLE_KEY_CHANNEL: {
        states: {
            on: { type: 'boolean', role: 'switch' },
        },
    },
    SMOKE_DETECTOR: {
        states: {
            smokeDetectorAlarmType: {
                type: 'string',
                role: 'text',
                states: {
                    IDLE_OFF: 'IDLE_OFF',
                    PRIMARY_ALARM: 'PRIMARY_ALARM',
                    INTRUSION_ALARM: 'INTRUSION_ALARM',
                    SECONDARY_ALARM: 'SECONDARY_ALARM',
                },
            },
        },
    },
    SMOKE_DETECTOR_CHANNEL: {
        states: {
            smokeDetectorAlarmType: {
                type: 'string',
                role: 'text',
                states: {
                    IDLE_OFF: 'IDLE_OFF',
                    PRIMARY_ALARM: 'PRIMARY_ALARM',
                    INTRUSION_ALARM: 'INTRUSION_ALARM',
                    SECONDARY_ALARM: 'SECONDARY_ALARM',
                },
            },
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
    SWITCH_CHANNEL: {
        states: {
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
            powerUpSwitchState: { type: 'string', role: 'state' },
            profileMode: { type: 'string', role: 'text', states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' } },
            userDesiredProfileMode: {
                type: 'string',
                role: 'state',
                states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' },
            },
        },
    },
    SWITCH_MEASURING_CHANNEL: {
        states: {
            currentPowerConsumption: { type: 'number', role: 'value', unit: 'W' },
            energyCounter: { type: 'number', role: 'value' },
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
            powerUpSwitchState: { type: 'string', role: 'state' },
            profileMode: { type: 'string', role: 'text', states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' } },
            resetEnergyCounter: {
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                parameter: 'resetEnergyCounter',
                writeOnly: true,
            },
            userDesiredProfileMode: {
                type: 'string',
                role: 'state',
                states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' },
            },
        },
    },
    TEMPERATURE_SENSOR_2_EXTERNAL_DELTA_CHANNEL: {
        states: {
            temperatureExternalDelta: { type: 'number', role: 'value.temperature' },
            temperatureExternalOne: { type: 'number', role: 'value.temperature' },
            temperatureExternalTwo: { type: 'number', role: 'value.temperature' },
        },
    },
    TEMPERATURE_SENSOR_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
        },
    },
    TILT_VIBRATION_SENSOR_CHANNEL: {
        states: {
            accelerationSensorEventFilterPeriod: {
                type: 'number',
                role: 'level',
                write: true,
                parameter: 'setAccelerationSensorEventFilterPeriod',
            },
            accelerationSensorMode: {
                type: 'string',
                role: 'text',
                states: { ANY_MOTION: 'ANY_MOTION', FLAT_DECT: 'FLAT_DECT' },
                write: true,
                parameter: 'setAccelerationSensorMode',
            },
            accelerationSensorSensitivity: {
                type: 'string',
                role: 'text',
                states: {
                    SENSOR_RANGE_16G: 'SENSOR_RANGE_16G',
                    SENSOR_RANGE_8G: 'SENSOR_RANGE_8G',
                    SENSOR_RANGE_4G: 'SENSOR_RANGE_4G',
                    SENSOR_RANGE_2G: 'SENSOR_RANGE_2G',
                    SENSOR_RANGE_2G_PLUS_SENS: 'SENSOR_RANGE_2G_PLUS_SENS',
                    SENSOR_RANGE_2G_2PLUS_SENSE: 'SENSOR_RANGE_2G_2PLUS_SENSE',
                },
                write: true,
                parameter: 'setAccelerationSensorSensitivity',
            },
            accelerationSensorTriggerAngle: {
                type: 'number',
                role: 'level',
                write: true,
                parameter: 'setAccelerationSensorTriggerAngle',
            },
            accelerationSensorTriggered: { type: 'boolean', role: 'indicator' },
        },
    },
    UNIVERSAL_ACTUATOR_CHANNEL: {
        states: {
            controlOnTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            controlRampTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            dimLevel: { type: 'number', role: 'level.dimmer', min: 0, max: 1, write: true, parameter: 'setDimLevel' },
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
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
            controlOnTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            controlRampTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            deviceOverheated: { type: 'boolean', role: 'indicator' },
            deviceOverloaded: { type: 'boolean', role: 'indicator' },
            dimLevel: { type: 'number', role: 'level.dimmer', min: 0, max: 1, write: true, parameter: 'setDimLevel' },
            dimLevelHighest: { type: 'number', role: 'value.brightness' },
            dimLevelLowest: { type: 'number', role: 'value.brightness' },
            dimmingMode: { type: 'string', role: 'text' },
            internalLinkConfiguration: { type: 'string', role: 'json' },
            multiModeInputMode: { type: 'string', role: 'text' },
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
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
    UNIVERSAL_LIGHT_CHANNEL: {
        states: {
            channelActive: { type: 'boolean', role: 'switch' },
            colorTemperature: {
                type: 'number',
                role: 'level.color.temperature',
                min: 2000,
                max: 6500,
                write: true,
                parameter: 'setColorTemperatureDimLevel',
            },
            connectedDeviceUnreach: { type: 'number', role: 'value' },
            controlGearFailure: { type: 'number', role: 'value' },
            controlOnTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            controlRampTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            dim2WarmActive: { type: 'boolean', role: 'indicator' },
            dimLevel: {
                type: 'number',
                role: 'level.dimmer',
                min: 0,
                max: 100,
                write: true,
                parameter: 'setDimLevel',
                derive: 'percent',
            },
            hardwareColorTemperatureColdWhite: { type: 'number', role: 'value' },
            hardwareColorTemperatureWarmWhite: { type: 'number', role: 'value' },
            hue: {
                type: 'number',
                role: 'level.color.hue',
                min: 0,
                max: 360,
                write: true,
                parameter: 'setHueSaturationDimLevel',
            },
            humanCentricLightActive: { type: 'boolean', role: 'switch' },
            lampFailure: { type: 'number', role: 'value' },
            lightSceneId: { type: 'number', role: 'level', write: true, parameter: 'startLightScene' },
            limitFailure: { type: 'number', role: 'value' },
            maximumColorTemperature: { type: 'number', role: 'value' },
            minimalColorTemperature: { type: 'number', role: 'value' },
            on: { type: 'boolean', role: 'switch', write: true, parameter: 'switchState' },
            profileMode: { type: 'string', role: 'text', states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' } },
            saturationLevel: {
                type: 'number',
                role: 'level.color.saturation',
                min: 0,
                max: 255,
                write: true,
                parameter: 'setHueSaturationDimLevel',
            },
            userDesiredProfileMode: {
                type: 'string',
                role: 'text',
                states: { AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' },
            },
        },
    },
    WALL_MOUNTED_THERMOSTAT_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
            display: {
                type: 'string',
                role: 'text',
                states: { ACTUAL: 'ACTUAL', SETPOINT: 'SETPOINT', ACTUAL_HUMIDITY: 'ACTUAL_HUMIDITY' },
                write: true,
                parameter: 'setClimateControlDisplay',
            },
            humidity: { type: 'number', role: 'value.humidity', unit: '%' },
            setPointTemperature: {
                type: 'number',
                role: 'level.temperature',
                unit: '°C',
                write: true,
                parameter: 'setPointTemperature',
                step: 0.5,
                debounce: 5000,
                targetGroups: true,
            },
            temperatureOffset: { type: 'number', role: 'value', unit: '°C' },
            vaporAmount: { type: 'number', role: 'level' },
        },
    },
    WALL_MOUNTED_THERMOSTAT_PRO_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
            display: {
                type: 'string',
                role: 'text',
                states: { ACTUAL: 'ACTUAL', SETPOINT: 'SETPOINT', ACTUAL_HUMIDITY: 'ACTUAL_HUMIDITY' },
                write: true,
                parameter: 'setClimateControlDisplay',
            },
            humidity: { type: 'number', role: 'value.humidity', unit: '%' },
            setPointTemperature: {
                type: 'number',
                role: 'level.temperature',
                unit: '°C',
                write: true,
                parameter: 'setPointTemperature',
                step: 0.5,
                debounce: 5000,
                targetGroups: true,
            },
            temperatureOffset: { type: 'number', role: 'value', unit: '°C' },
            vaporAmount: { type: 'number', role: 'level' },
        },
    },
    WALL_MOUNTED_THERMOSTAT_WITHOUT_DISPLAY_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature', unit: '°C' },
            humidity: { type: 'number', role: 'value.humidity', unit: '%' },
            setPointTemperature: {
                type: 'number',
                role: 'level.temperature',
                unit: '°C',
                write: true,
                parameter: 'setPointTemperature',
                step: 0.5,
                debounce: 5000,
                targetGroups: true,
            },
            temperatureOffset: { type: 'number', role: 'value', unit: '°C' },
            vaporAmount: { type: 'number', role: 'level' },
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
            controlOnTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            controlRampTime: { type: 'number', role: 'level.timer', unit: 's', def: 0, write: true, writeOnly: true },
            firstInputAction: { type: 'string', role: 'text' },
            profileMode: { type: 'string', role: 'text' },
            resetWaterVolume: {
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                parameter: 'resetWaterVolume',
                constant: false,
            },
            setWateringSwitchState: {
                type: 'boolean',
                role: 'switch',
                read: false,
                write: true,
                parameter: 'setWateringSwitchState',
                constant: false,
            },
            toggleWateringState: {
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                parameter: 'toggleWateringState',
                constant: false,
            },
            userDesiredProfileMode: { type: 'string', role: 'text' },
            waterFlow: { type: 'number', role: 'value', unit: 'l/min' },
            waterVolume: { type: 'number', role: 'value', unit: 'l' },
            waterVolumeSinceOpen: { type: 'number', role: 'value', unit: 'l' },
            wateringActive: { type: 'boolean', role: 'indicator' },
            wateringAmountTarget: { type: 'number', role: 'value', unit: 'l' },
            wateringOnTime: { type: 'number', role: 'value', unit: 's' },
        },
    },
    WATER_SENSOR_CHANNEL: {
        states: {
            acousticAlarmSignal: {
                type: 'string',
                role: 'text',
                states: {
                    DISABLE_ACOUSTIC_SIGNAL: 'DISABLE_ACOUSTIC_SIGNAL',
                    FREQUENCY_RISING: 'FREQUENCY_RISING',
                    FREQUENCY_FALLING: 'FREQUENCY_FALLING',
                    FREQUENCY_RISING_AND_FALLING: 'FREQUENCY_RISING_AND_FALLING',
                    FREQUENCY_ALTERNATING_LOW_HIGH: 'FREQUENCY_ALTERNATING_LOW_HIGH',
                    FREQUENCY_ALTERNATING_LOW_MID_HIGH: 'FREQUENCY_ALTERNATING_LOW_MID_HIGH',
                    FREQUENCY_HIGHON_OFF: 'FREQUENCY_HIGHON_OFF',
                    FREQUENCY_HIGHON_LONGOFF: 'FREQUENCY_HIGHON_LONGOFF',
                    FREQUENCY_LOWON_OFF_HIGHON_OFF: 'FREQUENCY_LOWON_OFF_HIGHON_OFF',
                    FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF: 'FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF',
                    LOW_BATTERY: 'LOW_BATTERY',
                    DISARMED: 'DISARMED',
                    INTERNALLY_ARMED: 'INTERNALLY_ARMED',
                    EXTERNALLY_ARMED: 'EXTERNALLY_ARMED',
                    DELAYED_INTERNALLY_ARMED: 'DELAYED_INTERNALLY_ARMED',
                    DELAYED_EXTERNALLY_ARMED: 'DELAYED_EXTERNALLY_ARMED',
                    EVENT: 'EVENT',
                    ERROR: 'ERROR',
                },
                write: true,
                parameter: 'setAcousticAlarmSignal',
            },
            acousticAlarmTiming: {
                type: 'string',
                role: 'text',
                states: {
                    PERMANENT: 'PERMANENT',
                    THREE_MINUTES: 'THREE_MINUTES',
                    SIX_MINUTES: 'SIX_MINUTES',
                    ONCE_PER_MINUTE: 'ONCE_PER_MINUTE',
                },
                write: true,
                parameter: 'setAcousticAlarmTiming',
            },
            acousticWaterAlarmTrigger: {
                type: 'string',
                role: 'text',
                states: {
                    NO_ALARM: 'NO_ALARM',
                    MOISTURE_DETECTION: 'MOISTURE_DETECTION',
                    WATER_DETECTION: 'WATER_DETECTION',
                    WATER_MOISTURE_DETECTION: 'WATER_MOISTURE_DETECTION',
                },
                write: true,
                parameter: 'setAcousticWaterAlarmTrigger',
            },
            inAppWaterAlarmTrigger: {
                type: 'string',
                role: 'text',
                states: {
                    NO_ALARM: 'NO_ALARM',
                    MOISTURE_DETECTION: 'MOISTURE_DETECTION',
                    WATER_DETECTION: 'WATER_DETECTION',
                    WATER_MOISTURE_DETECTION: 'WATER_MOISTURE_DETECTION',
                },
                write: true,
                parameter: 'setInAppWaterAlarmTrigger',
            },
            moistureDetected: { type: 'boolean', role: 'indicator' },
            sirenWaterAlarmTrigger: {
                type: 'string',
                role: 'text',
                states: {
                    NO_ALARM: 'NO_ALARM',
                    MOISTURE_DETECTION: 'MOISTURE_DETECTION',
                    WATER_DETECTION: 'WATER_DETECTION',
                    WATER_MOISTURE_DETECTION: 'WATER_MOISTURE_DETECTION',
                },
                write: true,
                parameter: 'setSirenWaterAlarmTrigger',
            },
            waterlevelDetected: { type: 'boolean', role: 'indicator' },
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
    WEATHER_SENSOR_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature' },
            humidity: { type: 'number', role: 'value.humidity' },
            illumination: { type: 'number', role: 'value.brightness' },
            illuminationThresholdSunshine: { type: 'number', role: 'level' },
            storm: { type: 'boolean', role: 'indicator' },
            sunshine: { type: 'boolean', role: 'indicator' },
            todaySunshineDuration: { type: 'number', role: 'value' },
            totalSunshineDuration: { type: 'number', role: 'value' },
            vaporAmount: { type: 'number', role: 'level' },
            windSpeed: { type: 'number', role: 'value.speed' },
            windValueType: {
                type: 'string',
                role: 'text',
                states: {
                    CURRENT_VALUE: 'CURRENT_VALUE',
                    MIN_VALUE: 'MIN_VALUE',
                    MAX_VALUE: 'MAX_VALUE',
                    AVERAGE_VALUE: 'AVERAGE_VALUE',
                },
            },
            yesterdaySunshineDuration: { type: 'number', role: 'value' },
        },
    },
    WEATHER_SENSOR_PLUS_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature' },
            humidity: { type: 'number', role: 'value.humidity' },
            illumination: { type: 'number', role: 'value.brightness' },
            illuminationThresholdSunshine: { type: 'number', role: 'level' },
            raining: { type: 'boolean', role: 'indicator' },
            storm: { type: 'boolean', role: 'indicator' },
            sunshine: { type: 'boolean', role: 'indicator' },
            todayRainCounter: { type: 'number', role: 'value.rain.today' },
            todaySunshineDuration: { type: 'number', role: 'value' },
            totalRainCounter: { type: 'number', role: 'level' },
            totalSunshineDuration: { type: 'number', role: 'value' },
            vaporAmount: { type: 'number', role: 'level' },
            windSpeed: { type: 'number', role: 'value.speed' },
            windValueType: {
                type: 'string',
                role: 'text',
                states: {
                    CURRENT_VALUE: 'CURRENT_VALUE',
                    MIN_VALUE: 'MIN_VALUE',
                    MAX_VALUE: 'MAX_VALUE',
                    AVERAGE_VALUE: 'AVERAGE_VALUE',
                },
            },
            yesterdayRainCounter: { type: 'number', role: 'level' },
            yesterdaySunshineDuration: { type: 'number', role: 'value' },
        },
    },
    WEATHER_SENSOR_PRO_CHANNEL: {
        states: {
            actualTemperature: { type: 'number', role: 'value.temperature' },
            humidity: { type: 'number', role: 'value.humidity' },
            illumination: { type: 'number', role: 'value.brightness' },
            illuminationThresholdSunshine: { type: 'number', role: 'level' },
            raining: { type: 'boolean', role: 'indicator' },
            storm: { type: 'boolean', role: 'indicator' },
            sunshine: { type: 'boolean', role: 'indicator' },
            todayRainCounter: { type: 'number', role: 'value.rain.today' },
            todaySunshineDuration: { type: 'number', role: 'value' },
            totalRainCounter: { type: 'number', role: 'level' },
            totalSunshineDuration: { type: 'number', role: 'value' },
            vaporAmount: { type: 'number', role: 'level' },
            weathervaneAlignmentNeeded: { type: 'boolean', role: 'indicator' },
            windDirection: { type: 'number', role: 'value' },
            windDirectionVariation: { type: 'number', role: 'value' },
            windSpeed: { type: 'number', role: 'value.speed' },
            windValueType: {
                type: 'string',
                role: 'text',
                states: {
                    CURRENT_VALUE: 'CURRENT_VALUE',
                    MIN_VALUE: 'MIN_VALUE',
                    MAX_VALUE: 'MAX_VALUE',
                    AVERAGE_VALUE: 'AVERAGE_VALUE',
                },
            },
            yesterdayRainCounter: { type: 'number', role: 'level' },
            yesterdaySunshineDuration: { type: 'number', role: 'value' },
        },
    },
};

// channel types whose payloads carry no key of their own, listed so they are not reported
// as unknown. A key that is merely null is a state with no value yet, not a missing state.

const STATELESS_CHANNELS = [
    'BLIND_GROUP_REMOTE_CONTROL_CHANNEL',
    'CODE_PROTECTED_SECONDARY_ACTION_CHANNEL',
    'INPUT_QUICK_ACTION_DISPLAY_CHANNEL',
];

/**
 * The channelEventType values a DEVICE_CHANNEL_EVENT can carry.
 *
 * The cloud raises a channel event on any functional channel, so an event for a type not in
 * EVENT_CHANNELS still gets its state - this list only decides which states exist up front.
 */
const CHANNEL_EVENTS = [
    'DOOR_BELL_SENSOR_EVENT',
    'KEY_PRESS_SHORT',
    'KEY_PRESS_LONG',
    'KEY_PRESS_LONG_START',
    'KEY_PRESS_LONG_STOP',
];

/** the codeState values a DEVICE_CODE_STATE_EVENT can carry, raised by the keypads */
const CODE_STATES = ['KNOWN_CODE_ID_RECEIVED', 'UNKNOWN_CODE_DETECTED'];

/**
 * channel types that mark a device as taking a code, so its code states exist before the first
 * one is entered. A code state event names only the device, so the states hang off the device.
 */
const CODE_STATE_CHANNELS = [
    'DEVICE_BLOCKING_WITH_TEACHABLE_CODE',
    'CODE_PROTECTED_PRIMARY_ACTION_CHANNEL',
    'CODE_PROTECTED_SECONDARY_ACTION_CHANNEL',
    'CODE_PROTECTED_SINGLE_ACTION_CHANNEL',
    'MULTI_MODE_LOCK_INPUT_CHANNEL',
];

/** channel types known to raise a channel event, so their states exist before the first press */
const EVENT_CHANNELS = [
    'SINGLE_KEY_CHANNEL',
    'MULTI_MODE_INPUT_CHANNEL',
    'MULTI_MODE_INPUT_SWITCH_CHANNEL',
    'MULTI_MODE_INPUT_BLIND_CHANNEL',
    'MULTI_MODE_INPUT_DIMMER_CHANNEL',
    'MULTI_MODE_LOCK_INPUT_CHANNEL',
    'GENERIC_INPUT_CHANNEL',
    'GENERIC_SWITCH_INPUT_CHANNEL',
];

const DERIVERS = {
    windowOpen: channel => channel.windowState === 'OPEN',
    // a valve with no reported position must not read as fully closed
    percent: value => (typeof value === 'number' ? value * 100 : value),
};

/**
 * ioBroker object definitions for a table of states.
 *
 * @param {object} states field name -> spec
 * @param {string} deviceId the device the channel belongs to
 * @param {string|number} channel the functional channel index
 * @param {object} functionalChannel the channel as delivered by the cloud
 * @returns {{field: string, common: object, native: object}[]} one entry per state
 */
function channelStateObjects(states, deviceId, channel, functionalChannel) {
    return Object.keys(states).map(field => {
        const spec = states[field];
        const common = { name: spec.name ?? field, type: spec.type, role: spec.role };
        if (spec.unit !== undefined) {
            common.unit = spec.unit;
        }
        if (spec.min !== undefined) {
            common.min = spec.min;
        }
        if (spec.max !== undefined) {
            common.max = spec.max;
        }
        if (spec.states !== undefined) {
            common.states = spec.states;
        }
        if (spec.def !== undefined) {
            common.def = spec.def;
        }
        common.read = spec.read ?? true;
        common.write = spec.write ?? false;

        let native = {};
        if (spec.parameter) {
            // a setpoint is set on the heating groups the channel belongs to, not on the device,
            // and _doStateChange iterates native.id to reach them
            native = spec.targetGroups ? { id: (functionalChannel || {}).groups } : { id: deviceId, channel };
            native.parameter = spec.parameter;
            if (spec.step !== undefined) {
                native.step = spec.step;
            }
            if (spec.debounce !== undefined) {
                native.debounce = spec.debounce;
            }
        }
        return { field, common, native };
    });
}

/**
 * Values for a table of states, read off one functional channel.
 *
 * A structured value has to be stringified here: it is declared as a json state, and the
 * adapter's state writer treats a raw object as an ioBroker state wrapper and would keep
 * only its `val`.
 *
 * @param {object} states field name -> spec
 * @param {object} functionalChannel the channel as delivered by the cloud
 * @returns {{field: string, value: boolean|number|string|null|undefined}[]} one entry per state
 */
function channelStateValues(states, functionalChannel) {
    const channel = functionalChannel || {};
    const out = [];
    for (const field of Object.keys(states)) {
        const spec = states[field];
        if (spec.writeOnly) {
            continue;
        }
        let value;
        if (Object.prototype.hasOwnProperty.call(spec, 'constant')) {
            value = spec.constant;
        } else if (spec.derive === 'windowOpen') {
            value = DERIVERS.windowOpen(channel);
        } else if (spec.derive === 'percent') {
            value = DERIVERS.percent(channel[spec.from ?? field]);
        } else {
            value = channel[spec.from ?? field];
        }
        if (spec.role === 'json' && value !== undefined && value !== null) {
            value = JSON.stringify(value);
        }
        out.push({ field, value });
    }
    return out;
}

module.exports = {
    CHANNEL_STATES,
    STATELESS_CHANNELS,
    CHANNEL_EVENTS,
    CODE_STATES,
    CODE_STATE_CHANNELS,
    EVENT_CHANNELS,
    DERIVERS,
    channelStateObjects,
    channelStateValues,
};
