'use strict';

var log = require('./log.js'),
    overlay = require('./overlay.js'),
    rcon = require('./rcon.js'),
    obs = require('./obs.js'),
    twitch = require('./twitch.js'),
    demo = require('./demo.js'),
    utils = require('./utils.js'),
    stdio = require('./stdio.js'),
    utils = require('./utils.js'),
    config = require('./config.js');

var http = require('http'),
    express = require('express'),
    path = require('path'),
    url = require('url'),
    app = express(),
    server = require('http').Server(app),
    io = require('socket.io')(server),
    exec = require('child_process').execFile;

// TODO: Clean up these globals
var app_loaded = false;
global.app_running = false,
global.demo_loaded = false,
global.demo_playback = false,
global.currentDemo = 0,
global.demos = [],
global.tempDemos = [],
global.recentDemos = [],
global.callbackUUID,
global.runVotes = [],
global.userSkips = [];
global.demoBlacklist = [];
global.demoRetry = 0;
global.runStartTimeout = 30000;
global.tfPath = '';

app.use('/public', express.static(path.join(__dirname, 'public')))

var launchCmd, obsCmd;

function startTF2()
{
    log.printLn('Launching TF2', log.severity.INFO);

    exec(launchCmd, null, { shell: true }, function (err, data)
    {
        if(err)
            console.log(err)
    }); 
}

function load()
{
    if (app_loaded)
    {
        log.printLn('Already loaded!', log.severity.DEBUG);
        return;
    }
    app_loaded = true;

    config.loadCfg((err, cfg) =>
    {
        if (err) throw err;

        if (cfg.obs.autoLaunch)
        {
            exec(obsCmd, null, { shell: true }, function (err, data)
            {
                if (err)
                    console.log(err)
            });

            obs.init();
            obs.instance.connect()
                .catch(err =>
                {
                    log.printLn('[OBS] Socket error!', log.severity.ERROR);
                    log.printLnNoStamp(JSON.stringify(err), log.severity.DEBUG);
                });
        }
        server.listen(cfg.overlay.port);
    });

    startTF2();
    rcon.init();
    demo.getDemos();
    // Refresh runs every 10 mins
    // TODO: Monitor tempus activity instead
    setTimeout(refresh, 10 * 60 * 1000);
}

function refresh()
{
    log.printLn('[TEMPUS] Checking for new runs..');
    demo.getDemos(true);
    setTimeout(() =>
    {
        for (var i = 0; i < demos.length; i++) {
            for (var e = 0; e < tempDemos.length; e++) {
                if (demos[i].record_info.id === tempDemos[e].record_info.id)
                    tempDemos.splice(e, 1);
            }
        }
        while (tempDemos.length > 0)
        {
            var found = false;
            for (var i = 0; i < demos.length; i++) {
                if (demos[i].demo_info.mapname === tempDemos[0].demo_info.mapname && demos[i].record_info.class === tempDemos[0].record_info.class && tempDemos[0].record_info.date > demos[i].record_info.date) {
                    if (i === currentDemo)
                    {
                        // Dont delete demo if currently playing
                        log.printLn(`[TEMPUS] Found new run but skipping because it is currently being played`, log.severity.WARN);
                    }
                    else
                    {
                        log.printLn(`[TEMPUS] Replacing run: '${demos[i].player_info.name} on ${demos[i].demo_info.mapname} as ${demos[i].record_info.class == 4 ? 'demoman' : 'soldier'} (${utils.msToTimeStamp(demos[i].record_info.duration * 1000)})'\n
                                with '${tempDemos[0].player_info.name} on ${tempDemos[0].demo_info.mapname} as ${tempDemos[0].record_info.class == 4 ? 'demoman' : 'soldier'} (${utils.msToTimeStamp(tempDemos[0].record_info.duration * 1000)})'!`, log.severity.INFO);
                        demos.splice(i, 1, tempDemos[0]);
                        if(twitch.instance())
                            twitch.instance().say(`New run added: '${demos[i].player_info.name} on ${demos[i].demo_info.mapname} as ${demos[i].record_info.class == 4 ? 'demoman' : 'soldier'} (${utils.msToTimeStamp(demos[i].record_info.duration * 1000)})'!`);
                    }

                    tempDemos.splice(0, 1);
                    found = true;
                    break;
                }
            }
            if (!found) {
                // No existing run
                log.printLn(`[TEMPUS] Added new run: '${tempDemos[0].player_info.name} on ${tempDemos[0].demo_info.mapname} as ${tempDemos[0].record_info.class == 4 ? 'demoman' : 'soldier'} (${utils.msToTimeStamp(tempDemos[0].record_info.duration * 1000)})'!`, log.severity.INFO);
                demos.push(tempDemos[0]);
                tempDemos.splice(0, 1);
                if (twitch.instance())
                    twitch.instance().say(`New run added: '${demos[demos.length].player_info.name} on ${demos[demos.length].demo_info.mapname} as ${demos[demos.length].record_info.class == 4 ? 'demoman' : 'soldier'} (${utils.msToTimeStamp(demos[demos.length].record_info.duration * 1000)})'!`);
            }
        }
    }, 60 * 1000);
    setTimeout(refresh, 10 * 60 * 1000);
}

function start()
{
    if (app_running)
    {
        log.printLn('Already running!', log.severity.INFO);
        return;
    }
    app_running = true;
    demo.init();
}

function stop()
{
    app_running = false;
    app_loaded = false;
    obs.instance.disconnect();
    rcon.instance().disconnect();
    utils.cleanUp();
}

// Serve overlay to obs
app.get('/overlay', function (req, res)
{
    res.sendFile(path.join(__dirname, '/public/www/overlay.html'));
});

config.loadCfg((err, cfg) =>
{
    if (err) return;

    tfPath = cfg.tf2.tfPath;
    // FIXME: This will only work with obs64, use regex to check if 32 or 64
    // obs wants working directory to be same as the .exe location
    // use cd /d
    obsCmd = `cd /d ${cfg.obs.path.split('obs64.exe')[0]}" && .\\obs64.exe`;
    launchCmd = cfg.steam.path + ` -applaunch ${cfg.steam.game}`;
    for (var i = 0; i < cfg.tf2.launchOptions.length; i++)
        launchCmd += ` ${cfg.tf2.launchOptions[i]}`;

    if (cfg.tv.autoLoad)
        load();
    // FIXME
    // use a callback instead of guessing how long it takes to load TF2 and tempus api stuff
    if (cfg.tv.autoStart)
        setTimeout(start, 60 * 1000);
});

// Server instance for overlay io socket
module.exports.server = server;
module.exports.load = load;
module.exports.start = start;
module.exports.stop = stop;
module.exports.io = io;
module.exports.startTF2 = startTF2;