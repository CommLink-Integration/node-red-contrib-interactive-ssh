'use strict';

const fs = require('fs');
const SSHConfig = require('ssh-config');

let sshCfg = undefined;

const getStringFromFile = (source) => {
  const data = fs.readFileSync(source, {
    encoding: 'utf8',
    flag: 'r'
  });
  return data;
};

const getSshCfg = () => {
  if (!sshCfg) {
    let fileName = process.env.HOME + '/.ssh/config';
    let cfgJson = getStringFromFile(fileName);
    sshCfg = SSHConfig.parse(cfgJson);
  }
  return sshCfg;
};

const extractHosts = () => {
  let cfg = getSshCfg();
  let result = [];
  for (let entry of cfg) {
    if (entry.param == 'Host') {
      let valyes = entry.value;
      if (Array.isArray(valyes)) {
        for (let c of valyes) {
          result.push(c);
        }
      } else {
        result.push(valyes);
      }
    }
  }
  return result;
};

const createConnectCfg = (config, msg) => {
  let host = msg.sshhost ? msg.sshhost : config.sshconfig;

  if (host == '-manual-') {
    console.log('Using manual configuration');
    return {
      host: config.host,
      port: config.port,
      keepaliveInterval: 5000,
      username: config.username,
      password: config.pass
    };
  }
  let cfg = getSshCfg();
  let hostCfg = cfg.compute(host);
  let fileName = hostCfg.IdentityFile[0].replace('~', process.env.HOME);
  console.log('Using ssh config file');
  const ssh_config = {
    host: hostCfg.Hostname,
    port: hostCfg.Port ?? 22,
    username: hostCfg.User,
    privateKey: fs.readFileSync(fileName)
  };
  return ssh_config;
};

module.exports = function (RED) {
  // Helper function to attempt connection
  const connect = (ssh_client, config) => {
    // console.log(`SSH connecting to ${config.username}@${config.host}:${config.port.toString()} with password ${config.pass}`);
    console.log(`Attempting to connect to ${config.host}`);
    // try {
    //     // Make sure the ssh_client passed in isn't being used
    //     ssh_client.end();
    // } catch {}
    try {
      ssh_client.connect(config);
    } catch (e) {
      node.error('ERRCONN', { errMsg: e, host: config.host });
    }
  };

  /* ssh connection */
  function InteractiveSSH(config) {
    RED.nodes.createNode(this, config);

    const debug = true;

    var Client = require('ssh2').Client;
    var conn = new Client();

    const allowKeepOpen = config.keepOpen;
    const minTimeout = 500;
    const maxTimeout = 1000 * 60 * 20; // 20 minutes
    let retryTimeoutID = null;

    let node = this;
    let retryTimeout = minTimeout;

    conn.on('ready', function () {
      if (debug) console.log(`SSH Connected ${config.sshconfig}`);
      retryTimeout = minTimeout;
      retryTimeoutID = null;

      node.status({
        fill: 'green',
        shape: 'dot',
        text: `connected ${config.sshconfig}!`
      });

      conn.shell(function (err, stream) {
        if (err) {
          node.error('ERRSHELL', { errMsg: err });
          conn.end();
        }

        if (debug) console.log('Shell opened');

        node.stream = stream;

        stream
          .on('close', function () {
            node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
            if (debug) console.log('Stream :: close');
            // conn.end();
          })
          .on('error', function (error) {
            if (debug) console.log('Stream :: error');
            node.status({ fill: 'red', shape: 'ring', text: 'error' });
            node.error('ERRSTREAM', { errMsg: error, host: ssh_config.host });
            // conn.end();
          })
          .on('data', function (data) {
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `connected ${config.sshconfig}!`
            });
            node.send({ host: ssh_config.host, payload: data });
          })
          .stderr.on('data', function (data) {
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `connected ${config.sshconfig}!`
            });
            node.send({ host: ssh_config.host, payload: data, stderr: true });
          });
      });
    });

    conn.on('error', function (e) {
      console.log(`Connection error: ${e.errno} ${e}`);
      node.error(`Connection error`, { errMsg: e, host: ssh_config.host });
      node.status({ fill: 'red', shape: 'ring', text: 'error' });
      conn.end();
    });

    conn.on('close', function () {
      if (debug) console.log('Socket was closed');
      node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });

      if (allowKeepOpen) {
        retryTimeout = Math.min(retryTimeout * 2, maxTimeout); // Exponential backoff for retrying connection
        if (debug)
          console.log(
            `Retrying SSH connection to ${ssh_config.host} in ${
              retryTimeout / 1000
            } second(s)`
          );

        retryTimeoutID = setTimeout(connect, retryTimeout, conn, ssh_config);
      }
    });

    conn.on('end', function () {
      if (debug) console.log('Socket was disconnected');
      node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });

      // if (allowKeepOpen) {
      //     retryTimeout = Math.min(retryTimeout*2, 60000); // Exponential backoff for retrying connection
      //     if (debug) console.log(`Retrying SSH connection to ${ssh_config.host} in ${retryTimeout/1000} second(s)`)
      //     setTimeout( connect, retryTimeout, conn, ssh_config);
      // }
    });

    const ssh_config = createConnectCfg(config, {});

    connect(conn, ssh_config);

    node.on('input', function (msg) {
      const data = msg.payload;
      // TODO: check if host was overwritten and needs reconnect
      const msghost = msg.sshhost;
      const confighost = config.sshconfig;
      if (msghost && msghost != confighost) {
        const new_config = createConnectCfg(config, msg);
        connect(conn, new_config);
      }
      if (data) {
        if (data.connect == true) {
          console.log('Requesting manual reconnection');
          if (retryTimeoutID !== null) {
            console.log('Attempting manual reconnection');
            clearTimeout(retryTimeoutID);
            retryTimeout = minTimeout;
            retryTimeoutID = setTimeout(
              connect,
              retryTimeout,
              conn,
              ssh_config
            );
            // conn.end()
          }
          // retryTimeout = minTimeout
        } else {
          try {
            if (node.stream.writable) {
              node.stream.write(data);
            } else {
              console.log('Stream not currently writable. Try again.');
              node.error('Stream not currently writable. Try again.', {
                errmsg: 'Stream not currently writable. Try again.'
              });
            }
          } catch (e) {
            node.error('Error writing to stream', { errmsg: e });
          }
        }
      }
    });

    node.on('close', function (done) {
      clearTimeout(retryTimeoutID);
      node.stream.removeAllListeners();
      node.stream.end('bye\r\n');
      conn.removeAllListeners();
      conn.end();
      node.status({});
      done();
    });
  }
  RED.nodes.registerType('interactive-ssh', InteractiveSSH, {
    settings: {
      interactiveSshHosts: {
        value: extractHosts(),
        exportable: true
      }
    }
  });
};
