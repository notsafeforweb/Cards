/**
 * Front controller for the application server
 *
 * Sets up the server and default routes.
 */


// Module dependencies
var express = require('express');
var connect = require('connect');
var io = require('socket.io');
var mongoose = require('mongoose');


// Initialize app
var app = module.exports = express.createServer().listen(3000);
var sio = io.listen(app);


var MemoryStore = express.session.MemoryStore;
var sessionStore = new MemoryStore();

var Game = require('./lib/models/game');
var GameType = require('./lib/models/game_type');
var Player = require('./lib/models/player');
var Room = require('./lib/models/room');
var User = require('./lib/models/user');


// Configuration app
app.configure(function(){
    app.set('views', __dirname + '/views');
    app.set('view engine', 'ejs');
    app.use(express.bodyParser());
    app.use(express.cookieParser());
    app.use(express.session({ secret: 'Sl18TAiM4B49g9CD1TK9oVJIyoH63Sdq', store: sessionStore }));
    app.use(app.router);
    app.use(express.static(__dirname + '/public'));

    mongoose.connect('mongodb://localhost/cards');

    // Set up any missing users
    ['court', 'dan', 'elyse', 'kurt'].forEach(function(username){
        mongoose.model('User').findOne({ username: username }, function(error, user){
            if (error) {
                console.error('Could not determine if user `' + username + '` exists: ' + error);
            } else if (!user) {
                user = new User({ username: username });
                user.save();
                console.info('Created user: ' + username);
            }
        });
    });

    // Set up any missing rooms
    ['cerf', 'babbage', 'lovelace', 'dijkstra'].forEach(function(name){
        mongoose.model('Room').findOne({ name: name }, function(error, room){
            if (error) {
                console.error('Could not determine if room `' + name + '` exists: ' + error);
            } else if (!room) {
                room = new Room({ name: name, game: {}, players: {} });
                room.save();
                console.info('Created room: ' + name);
            }
        });
    });

    // Set up any missing game types
    ['golf'].forEach(function(name){
        mongoose.model('GameType').findOne({ name: name }, function(error, type){
            if (error) {
                console.error('Could not determine if game type `' + name + '` exists: ' + error);
            } else if (!type) {
                type = new GameType({ name: name });
                type.save();
                console.info('Created game type: ' + name);
            }
        });
    });
});

app.configure('development', function(){
    app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});

app.configure('production', function(){
    app.use(express.errorHandler());
});


/**
 * Creates a new error type and returns the resulting json
 *
 * @param severity
 * @param code
 */
function createError(severity, type)
{
    // @todo Add logging

    var data = {severity: severity};
    if (typeof type != 'undefined') {
        data.type = type;
    }

    var Error = mongoose.model('Error');
    return (new Error(data)).toJSON();
}


// When a new websocket opens, set up a session object that we can access on future calls
// through that same websocket
sio.set('authorization', function(data, accept){
    if (data.headers.cookie) {
        data.cookie = connect.utils.parseCookie(data.headers.cookie);
        data.sessionID = data.cookie['connect.sid'];
        data.sessionStore = sessionStore;
        sessionStore.get(data.sessionID, function(error, session){
            if (error || !session) {
                accept('Failed to read session information', false);
            } else {
                data.session = new connect.middleware.session.Session(data, session);
                accept(null, true);
            }
        });
    } else {
        return accept('No cookie transmitted.', false);
    }
});

// Express sessions will timeout if there hasn't been a new HTTP request after a certain period of time.
// Since most of our functionality is handled through an open websocket rather than HTTP requests,
// we make sure to keep the session alive.
sio.sockets.on('connection', function(socket){
    var handshake = socket.handshake;
    var user = handshake.session.user;

    console.log('A socket with sessionID ' + handshake.sessionID + ' connected.');

    // Every minute make sure that the session remains alive (heartbeat)
    var intervalID = setInterval(function(){
        handshake.session.reload(function(){
            handshake.session.touch().save();
        });
    }, 60 * 1000);

    socket.on('disconnect', function(){
        console.log('A socket with sessionID ' + handshake.sessionID + ' disconnected.');
        clearInterval(intervalID);
    });

    socket.on('model:sync', function(method, context, data, callback){
        console.log(method);
        console.log(context);
        console.log(data);
        callback(null, data);
    });

    socket.on('collection:sync', function(method, context, data, callback){
        console.log(method);
        console.log(context);
        console.log(data);
        callback(null, data);
    });

    // @todo get rid of this in favor of fetching a room with model:sync
    socket.on('room:load', function(roomId, callback){
        mongoose.model('Room').findOne({ name: roomId }).populate('game').run(function(error, room){
            if (error) {
                console.error(error);
                return;
            } else if (!room) {
                callback(createError('FATAL', 'app:no-room'));
                return;
            }

            mongoose.model('Player').find({ room: room }, ['_id', 'name'], function(error, players){
                if (error) {
                    console.error(error);
                    return;
                }

                var player = new Player({ name: user.username, room: room._id, user: user._id });
                player.save(function(error){
                    if (error) {
                        console.error(error);
                        return;
                    }

                    // Ensures that this client is subscribed to this room's socket namespace
                    socket.join(room.name);

                    // Notifies existing players in the room when this client disconnects
                    socket.on('disconnect', function(){
                        player.remove(function(error){
                            if (error) {
                                console.error(error);
                                return;
                            }

                            socket.broadcast.to(room.name).emit('app:player-disconnected', player);
                        });
                    });

                    players.push(player);

                    var data = {
                        room: room.toJSON(),
                        player: player.toJSON(),
                        players: players
                    };

                    callback(null, data);
                });
            });
        });
    });
});


// A catch-all to make sure the user specifies a room or logs in
app.get('/', function(request, response){
    if (request.session.user) {
        mongoose.model('Room').find({}, function(error, rooms){
            if (error) {
                console.error('Failed to retrieve rooms: ' + error);
            } else {
                response.render('select_room', {rooms: rooms});
            }
        });
    } else {
        response.render('auth');
    }
});

// Handle authentication attempts
app.post('/', function(request, response){
    var username = request.body.auth;

    if (request.session.user || !username) {
        response.redirect('home');
        return;
    }

    mongoose.model('User').findOne({ username: username }, function(error, user){
        if (error) {
            console.error('Failed to retrieve user information: ' + error);
        } else if (!user) {
            console.info('No user found with that username: ' + username);
        } else {
            console.info('User successfully logged in: ' + username);
            request.session.user = user;
        }

        response.redirect('home');
    });
});

// Load the game screen for the specified room
app.get('/room/:name', function(request, response){
    if (!request.session.user) {
        response.redirect('home');
        return;
    }

    response.render('room', {room: request.params.name});
});


// Some details about the server
console.log("Server listening on port %d in %s mode", app.address().port, app.settings.env);