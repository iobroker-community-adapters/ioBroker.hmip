import React from 'react';

import { LinearProgress, Button, CircularProgress } from '@mui/material';

// important to make from package and not from some children.
// invalid
// import ConfigGeneric from '@iobroker/adapter-react-v5/ConfigGeneric';
// valid
import { I18n } from '@iobroker/adapter-react-v5';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

interface HmipComponentState extends ConfigGenericState {
    response: string;
    running: boolean;
    initialized: boolean;
    error: boolean;
}

class HmipComponent extends ConfigGeneric<ConfigGenericProps, HmipComponentState> {
    private alive: boolean;
    private askTimeout: ReturnType<typeof setTimeout> | null = null;

    constructor(props: ConfigGenericProps) {
        super(props);

        this.alive = false;

        this.state = {
            ...this.state,
            response: '',
            running: false,
            initialized: false,
            error: false,
        };
    }

    componentWillUnmount(): void {
        super.componentWillUnmount();
        if (this.askTimeout) {
            clearTimeout(this.askTimeout);
            this.askTimeout = null;
        }
    }

    async askState(): Promise<void> {
        const response = await this.props.oContext.socket.sendTo(
            `hmip.${this.props.oContext.instance}`,
            'requestTokenState',
            null,
        );

        if (this.handleResponse(response)) {
            this.askTimeout ||= setTimeout(() => {
                this.askTimeout = null;
                void this.askState();
            }, 300);
        }
    }

    handleResponse(response: {
        state: string;
        authToken?: string;
        clientAuthToken?: string;
        clientId?: string;
    }): boolean {
        switch (response.state) {
            case 'startedTokenCreation':
                this.setState({ response: 'started token creation', running: true });
                return true;
            case 'waitForBlueButton':
                this.setState({ response: 'press blue button on accesspoint', running: true });
                return true;
            case 'confirmToken':
                this.setState({ response: 'confirming token', running: true });
                return true;
            case 'errorOccurred':
                this.setState({
                    response: 'error occurred during token generation, look at the logs',
                    running: false,
                    error: true,
                });
                break;
            case 'idle':
                this.setState({ response: 'press "request token"', running: false });
                break;
            case 'tokenCreated': {
                this.setState({ response: 'token created, save settings to use your accesspoint', running: false });

                ConfigGeneric.setValue(this.props.data, 'authToken', response.authToken);
                ConfigGeneric.setValue(this.props.data, 'clientAuthToken', response.clientAuthToken);
                ConfigGeneric.setValue(this.props.data, 'clientId', response.clientId);

                this.props.onChange(this.props.data, undefined, () =>
                    this.props.oContext.forceUpdate(['authToken', 'clientAuthToken', 'clientId'], this.props.data),
                );
                break;
            }
        }
        return false;
    }

    requestToken(): void {
        this.setState({ response: 'started token creation', running: true, error: false }, async () => {
            const config = {
                accessPointSgtin: ConfigGeneric.getValue(this.props.data, 'accessPointSgtin'),
                clientId: ConfigGeneric.getValue(this.props.data, 'clientId'),
                pin: ConfigGeneric.getValue(this.props.data, 'pin') || '',
                deviceName: ConfigGeneric.getValue(this.props.data, 'deviceName'),
            };

            const response = await this.props.oContext.socket.sendTo(
                `hmip.${this.props.oContext.instance}`,
                'requestToken',
                config,
            );

            if (this.handleResponse(response)) {
                this.askTimeout ||= setTimeout(() => {
                    this.askTimeout = null;
                    void this.askState();
                }, 300);
            }
        });
    }

    renderItem(): React.JSX.Element {
        if (this.alive !== this.props.alive) {
            this.alive = this.props.alive;
            if (this.alive && !this.state.initialized) {
                // Ask hmip instance
                setTimeout(() => this.setState({ initialized: true }, () => this.askState()), 100);
            }
        }

        if (!this.props.oContext.theme) {
            return <div>...</div>;
        }

        if (!this.props.alive && !this.state.initialized) {
            return <div className="hmip-admin-component">{I18n.t('custom_hmip_not_alive')}</div>;
        }
        if (!this.state.initialized) {
            return <LinearProgress />;
        }

        const accessPointSgtin = ConfigGeneric.getValue(this.props.data, 'accessPointSgtin');

        let instruction = null;
        if (this.state.response === 'press "request token"') {
            instruction = I18n.t('custom_hmip_press_hcu_button').split('"Home Control Unit"');
            if (instruction.length === 2) {
                instruction = (
                    <div style={{ width: '100%' }}>
                        <span>{instruction[0]}</span>
                        <span
                            style={{
                                marginLeft: 1,
                                marginRight: 1,
                                fontWeight: 600,
                                color: this.props.oContext.themeType === 'dark' ? '#0091c5' : '#004b61',
                            }}
                        >
                            "Home Control Unit"
                        </span>
                        <span>{instruction[1]}</span>
                    </div>
                );
            } else {
                instruction = <div style={{ width: '100%' }}>{I18n.t('custom_hmip_press_hcu_button')}</div>;
            }
        }

        return (
            <div
                style={{ width: '100%' }}
                className="hmip-admin-component"
            >
                {instruction}
                <div
                    style={{
                        color: this.state.error
                            ? this.props.oContext.themeType === 'dark'
                                ? '#c20000'
                                : '#800000'
                            : undefined,
                        marginBottom: 8,
                    }}
                >
                    {I18n.t(`custom_hmip_${this.state.response}`).replace('custom_hmip_', '')}
                </div>
                <Button
                    variant="contained"
                    color="primary"
                    disabled={this.state.running || !accessPointSgtin}
                    onClick={() => this.requestToken()}
                >
                    {this.state.running ? <CircularProgress size={24} /> : I18n.t('custom_hmip_request_token')}
                </Button>
            </div>
        );
    }
}

export default HmipComponent;
