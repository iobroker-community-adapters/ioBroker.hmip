// Augments the globally declared ioBroker types with everything this adapter adds.
// The attributes of `AdapterConfig` must be kept in sync with `native` in io-package.json
// and with admin/jsonConfig.json.

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** the name this client registers itself under at the access point */
            deviceName: string;
            /** a uuid generated on first start, so the access point recognises this client again */
            deviceId: string;
            /** handed out by the access point once the blue button was pressed */
            authToken: string;
            /** derived from the SGTIN, not from the token exchange */
            clientAuthToken: string;
            /** handed out together with the auth token */
            clientId: string;
            /** the access point's SGTIN, the identifier printed on it */
            accessPointSgtin: string;
            /** only set when the access point is pin protected */
            pin: string;
        }
    }
}

// this is required so the above is treated as a module
export {};
