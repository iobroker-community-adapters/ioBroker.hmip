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
        Object.assign(this.state, {
            response: false,
            running: false,
            initialized: false,
            alive: false,
            error: false,
            theme: Theme(this.props.themeName || 'light'),
        });
    }

    componentDidMount() {
        super.componentDidMount();
        const state = this.props.socket.getState(`hmip.${this.props.instance}.alive`);
        if (state?.val) {
            this.setState({ alive: true, initialized: true }, () => this.askState());
        }
        this.props.socket.subscribeState(`system.adapter.hmip.${this.props.instance}.alive`, this.onAliveChanged);
    }

    componentWillUnmount() {
        super.componentWillUnmount();
        this.props.socket.unsubscribeState(`system.adapter.hmip.${this.props.instance}.alive`, this.onAliveChanged);
        if (this.askTimeout) {
            clearTimeout(this.askTimeout);
            this.askTimeout = null;
        }
    }

    async askState() {
        const response = await this.props.socket.sendTo(`hmip.${this.props.instance}`, 'requestTokenState', null);

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
        const response = await this.props.socket.sendTo(`hmip.${this.props.instance}`, 'requestToken', config);
        if (this.handleResponse(response)) {
            this.askTimeout = this.askTimeout || setTimeout(() => {
                this.askTimeout = null;
                this.askState();
            }, 300);
        }
    }

    onAliveChanged = (id, state) => {
        const alive = state ? state.val : false;
        if (alive !== this.state.alive) {
            this.setState({ alive }, () => {
                if (alive && !this.state.initialized) {
                    setTimeout(() =>
                        this.setState({ initialized: true }, () => this.askState(), 100));
                }
            });
        }
    };

    renderItem() {
        if (!this.state.alive && !this.state.initialized) {
            return <ThemeProvider theme={this.state.theme}>
                <div>{I18n.t('custom_hmip_not_alive')}</div>
            </ThemeProvider>;
        }
        if (!this.state.initialized) {
            return <ThemeProvider theme={this.state.theme}>
                <LinearProgress />
            </ThemeProvider>;
        }

        const accessPointSgtin = ConfigGeneric.getValue(this.props.data, 'accessPointSgtin');

        return <ThemeProvider theme={this.state.theme}>
            <div style={{ width: '100%'}}>
                <div
                    style={{
                        color: this.state.error ? (this.props.themeType === 'dark' ? '#c20000' : '#800000') : undefined,
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
    socket: PropTypes.object.isRequired,
    themeType: PropTypes.string,
    themeName: PropTypes.string,
    style: PropTypes.object,
    className: PropTypes.string,
    data: PropTypes.object.isRequired,
    attr: PropTypes.string,
    schema: PropTypes.object,
    onError: PropTypes.func,
    onChange: PropTypes.func,
};

export default HmipComponent;
