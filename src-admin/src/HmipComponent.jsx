import React from 'react';
import PropTypes from 'prop-types';
import { ThemeProvider } from '@mui/material/styles';

import {
    LinearProgress,
    Button,
    CircularProgress,
} from '@mui/material';

// important to make from package and not from some children.
// invalid
// import ConfigGeneric from '@iobroker/adapter-react-v5/ConfigGeneric';
// valid
import { I18n, Theme } from '@iobroker/adapter-react-v5';
import { ConfigGeneric } from '@iobroker/json-config';

class HmipComponent extends ConfigGeneric {
    constructor(props) {
        super(props);

        this.alive = false;

        Object.assign(this.state, {
            response: false,
            running: false,
            initialized: false,
            error: false,
        });

        this.socket = this.props.oContext?.socket || this.props.socket;
    }

    componentWillUnmount() {
        super.componentWillUnmount();
        if (this.askTimeout) {
            clearTimeout(this.askTimeout);
            this.askTimeout = null;
        }
    }

    async askState() {
        const response = await this.socket.sendTo(`hmip.${this.props.instance}`, 'requestTokenState', null);

        if (this.handleResponse(response)) {
            this.askTimeout = this.askTimeout || setTimeout(() => {
                this.askTimeout = null;
                this.askState();
            }, 300);
        }
    }

    handleResponse(response) {
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
                this.setState({ response: 'error occurred during token generation, look at the logs', running: false, error: true });
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
                    this.props.forceUpdate(['authToken', 'clientAuthToken', 'clientId'], this.props.data));
                break;
            }
        }
        return false;
    }

    async requestToken() {
        const config = {
            accessPointSgtin: ConfigGeneric.getValue(this.props.data, 'accessPointSgtin'),
            clientId: ConfigGeneric.getValue(this.props.data, 'clientId'),
            pin: ConfigGeneric.getValue(this.props.data, 'pin') || '',
            deviceName: ConfigGeneric.getValue(this.props.data, 'deviceName'),
        };
        this.setState({ response: 'started token creation', running: true, error: false });
        const response = await this.socket.sendTo(`hmip.${this.props.instance}`, 'requestToken', config);
        if (this.handleResponse(response)) {
            this.askTimeout = this.askTimeout || setTimeout(() => {
                this.askTimeout = null;
                this.askState();
            }, 300);
        }
    }

    renderItem() {
        if (this.alive !== this.props.alive) {
            this.alive = this.props.alive;
            if (this.alive && !this.state.initialized) {
                // Ask hmip instance
                setTimeout(() =>
                    this.setState({ initialized: true }, () => this.askState(), 100));
            }
        }

        if (!this.props.alive && !this.state.initialized) {
            return <ThemeProvider theme={this.props.oContext?.theme || this.props.theme}>
                <div className="hmip-admin-component">{I18n.t('custom_hmip_not_alive')}</div>
            </ThemeProvider>;
        }
        if (!this.state.initialized) {
            return <ThemeProvider theme={this.props.oContext?.theme || this.props.theme} className="hmip-admin-component">
                <LinearProgress />
            </ThemeProvider>;
        }

        const accessPointSgtin = ConfigGeneric.getValue(this.props.data, 'accessPointSgtin');

        return <ThemeProvider theme={this.props.oContext?.theme || this.props.theme}>
            <div style={{ width: '100%'}} className="hmip-admin-component">
                <div
                    style={{
                        color: this.state.error ? ((this.props.oContext?.themeType || this.props.themeType) === 'dark' ? '#c20000' : '#800000') : undefined,
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
        </ThemeProvider>;
    }
}

HmipComponent.propTypes = {
    // @deprecated
    socket: PropTypes.object.isRequired,
    // @deprecated
    themeType: PropTypes.string,
    // @deprecated
    themeName: PropTypes.string,

    oContext: PropTypes.object,

    style: PropTypes.object,
    className: PropTypes.string,
    data: PropTypes.object.isRequired,
    attr: PropTypes.string,
    schema: PropTypes.object,
    onError: PropTypes.func,
    onChange: PropTypes.func,
};

export default HmipComponent;
