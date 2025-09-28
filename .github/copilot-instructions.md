# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

### HomeMatic IP Cloud Adapter Specifics

This adapter connects ioBroker to HomeMatic IP devices via the HomeMatic IP Cloud Rest API. Key characteristics:

- **Purpose**: Interface with HomeMatic IP CloudAccessPoint to control smart home devices (thermostats, door locks, sensors, etc.)
- **API Communication**: Uses REST API calls to HomeMatic IP Cloud with authentication tokens
- **WebSocket Connection**: Maintains real-time event updates from HomeMatic IP devices
- **Device Support**: Handles various HomeMatic IP device types with specific state mappings
- **Authentication**: Uses SGTIN (Access Point serial) and PIN for initial setup, then token-based auth
- **Rate Limiting**: Important to minimize API requests as EQ-3 blocks IPs with excessive traffic
- **Device States**: Complex state mapping between HomeMatic IP device properties and ioBroker objects

## Testing

### Unit Testing
- Use Jest as the primary testing framework for ioBroker adapters
- Create tests for all adapter main functions and helper methods
- Test error handling scenarios and edge cases
- Mock external API calls and hardware dependencies
- For adapters connecting to APIs/devices not reachable by internet, provide example data files to allow testing of functionality without live connections
- Example test structure:
  ```javascript
  describe('AdapterName', () => {
    let adapter;
    
    beforeEach(() => {
      // Setup test adapter instance
    });
    
    test('should initialize correctly', () => {
      // Test adapter initialization
    });
  });
  ```

### Integration Testing

**IMPORTANT**: Use the official `@iobroker/testing` framework for all integration tests. This is the ONLY correct way to test ioBroker adapters.

**Official Documentation**: https://github.com/ioBroker/testing

#### Framework Structure
Integration tests MUST follow this exact pattern:

```javascript
const path = require('path');
const { tests } = require('@iobroker/testing');

// Define test coordinates or configuration
const TEST_COORDINATES = '52.520008,13.404954'; // Berlin
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Use tests.integration() with defineAdditionalTests
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test adapter with specific configuration', (getHarness) => {
            let harness;

            before(() => {
                harness = getHarness();
            });

            it('should configure and start adapter', function () {
                return new Promise(async (resolve, reject) => {
                    try {
                        harness = getHarness();

                        // Start the adapter and wait for it to start
                        await harness.startAdapterAndWait();

                        // Test adapter states and functionality
                        await harness.states.getStateAsync('system.adapter.adapterName.0.info.connection');

                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            after(async () => {
                if (harness) {
                    await harness.stopAdapter();
                }
            });
        });
    }
});
```

## Code Patterns & Architecture

### Adapter Structure
- **main.js**: Entry point containing the main adapter logic
- **admin/**: Configuration interface files (HTML, CSS, JS)
- **lib/**: Helper libraries and utilities
- **api/**: Optional API endpoint definitions

### State Management
- Use `this.setState()` for setting device states
- Always include proper error handling with try-catch blocks
- Implement `ack: true` for confirmed state changes
- Use proper data types as defined in io-package.json

### Event Handling
```javascript
// Proper event subscription pattern
this.on('stateChange', (id, state) => {
    if (!state || state.ack) return;
    
    // Handle state change
    this.handleStateChange(id, state);
});
```

### Error Handling
```javascript
// Standard error handling pattern
try {
    await this.someAsyncOperation();
} catch (error) {
    this.log.error(`Operation failed: ${error.message}`);
    // Handle error appropriately
}
```

## HomeMatic IP Specific Patterns

### API Communication
```javascript
// Standard API request pattern with proper error handling
async makeApiRequest(endpoint, method = 'GET', data = null) {
    try {
        const response = await this.axios({
            method,
            url: `${this.apiUrl}${endpoint}`,
            headers: {
                'AUTHTOKEN': this.authToken,
                'CLIENTAUTH': this.clientAuthToken
            },
            data
        });
        return response.data;
    } catch (error) {
        this.log.error(`API request failed: ${error.message}`);
        throw error;
    }
}
```

### WebSocket Event Handling
```javascript
// WebSocket connection management
initWebSocket() {
    this.ws = new WebSocket(this.wsUrl);
    
    this.ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            this.handleWebSocketMessage(message);
        } catch (error) {
            this.log.error(`WebSocket message parsing failed: ${error.message}`);
        }
    });
    
    this.ws.on('error', (error) => {
        this.log.error(`WebSocket error: ${error.message}`);
        this.reconnectWebSocket();
    });
}
```

### Device State Mapping
```javascript
// Convert HomeMatic IP device states to ioBroker objects
mapDeviceState(device, property, value) {
    const stateId = `${device.id}.${property}`;
    
    // Apply proper data type conversion
    const mappedValue = this.convertValue(value, property);
    
    this.setState(stateId, {
        val: mappedValue,
        ack: true,
        ts: Date.now()
    });
}
```

## Configuration & Setup

### Admin Interface
- Use TypeScript for new admin interfaces (Admin 7.6+ requirement)
- Implement proper validation for SGTIN and PIN inputs
- Provide clear feedback for authentication status
- Include device discovery and selection features

### Authentication Flow
```javascript
// Authentication token generation
async authenticate(sgtin, pin) {
    try {
        const authResponse = await this.requestAuthToken(sgtin, pin);
        if (authResponse.authToken) {
            this.authToken = authResponse.authToken;
            this.log.info('Authentication successful');
            return true;
        }
        return false;
    } catch (error) {
        this.log.error(`Authentication failed: ${error.message}`);
        return false;
    }
}
```

## Best Practices

### Performance
- Implement proper request rate limiting to avoid IP blocking by EQ-3
- Use efficient polling intervals for device updates
- Cache device information to minimize API calls
- Implement exponential backoff for failed requests

### Logging
```javascript
// Use appropriate log levels
this.log.debug('Detailed debug information');
this.log.info('General information');
this.log.warn('Warning message');
this.log.error('Error message');
```

### Resource Management
```javascript
// Proper cleanup in unload method
unload(callback) {
    try {
        if (this.ws) {
            this.ws.close();
        }
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
        callback();
    } catch (error) {
        callback();
    }
}
```

### State Definitions
- Follow ioBroker naming conventions for states
- Include proper metadata (unit, role, type, read/write permissions)
- Implement state validation before setting values
- Use meaningful descriptions for all states

### Security
- Never log sensitive data (PINs, tokens, personal information)
- Validate all input data before processing
- Implement proper token refresh mechanisms
- Use secure communication protocols (HTTPS, WSS)

## Development Tools & Dependencies

### Required Dependencies
- `@iobroker/adapter-core`: Core adapter functionality
- `axios`: HTTP client for API requests
- `ws`: WebSocket client for real-time events
- `uuid`: Generate unique identifiers
- `js-sha512`: Cryptographic hashing for authentication

### Development Dependencies
- `@iobroker/testing`: Official testing framework
- `@iobroker/eslint-config`: Code style configuration
- `mocha`: Test runner
- `chai`: Assertion library

### Build Tools
- Use the provided `tasks.js` for building admin interface
- TypeScript compilation for admin interface components
- ESLint configuration for code quality
- Automated testing with GitHub Actions

Remember to always test thoroughly with real HomeMatic IP devices when possible, and provide mock data for automated testing environments.