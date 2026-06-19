const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

const app = express();
const server = http.createServer(app);

// Allow all origins so ngrok / Tailscale tunnels work without CORS errors
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling']
});

app.use(express.static('public'));

const rooms = {};

// Fully randomized brick placement — every game is unique!
function createBricks() {
    const bricks = [];

    const brickW = 36;
    const brickH = 16;
    const padding = 8; // min gap between bricks

    // Safe play zone: avoid paddles (top ~55px, bottom ~55px) and walls
    const zoneLeft = 20;
    const zoneRight = 800 - 20 - brickW;
    const zoneTop = 80;
    const zoneBottom = 520 - brickH;

    // Random brick count each round (25–50)
    const count = 25 + Math.floor(Math.random() * 26);
    const maxAttempts = count * 30; // prevent infinite loops
    let attempts = 0;

    while (bricks.length < count && attempts < maxAttempts) {
        attempts++;

        const x = zoneLeft + Math.floor(Math.random() * (zoneRight - zoneLeft));
        const y = zoneTop + Math.floor(Math.random() * (zoneBottom - zoneTop));

        // Check overlap with existing bricks (including padding gap)
        let overlaps = false;
        for (const b of bricks) {
            if (
                x < b.x + b.width + padding &&
                x + brickW + padding > b.x &&
                y < b.y + b.height + padding &&
                y + brickH + padding > b.y
            ) {
                overlaps = true;
                break;
            }
        }

        if (!overlaps) {
            bricks.push({
                x,
                y,
                width: brickW,
                height: brickH,
                destroyed: false,
                colorIndex: Math.floor(Math.random() * 8)
            });
        }
    }

    // Fallback if somehow empty
    if (bricks.length === 0) {
        for (let i = 0; i < 8; i++) {
            bricks.push({
                x: 200 + i * 50,
                y: 290,
                width: brickW,
                height: brickH,
                destroyed: false,
                colorIndex: 3
            });
        }
    }

    return bricks;
}

function createRoom(roomId) {
    return {
        id: roomId,
        state: 'lobby', // 'lobby', 'countdown', 'playing', 'gameover'
        host: null,
        countdown: 3,
        ball: {
            x: 400,
            y: 300,
            dx: 0,
            dy: 0,
            speed: 5,
            radius: 10,
        },
        bricks: createBricks(),
        players: {},
        winner: null,
        images: {
            1: null,
            2: null
        }
    };
}

function getRoomState(room) {
    return {
        id: room.id,
        state: room.state,
        host: room.host,
        countdown: room.countdown,
        ball: room.ball,
        bricks: room.bricks,
        players: room.players,
        winner: room.winner
    };
}

function joinPlayerToRoom(socket, roomId, playerInfo = {}) {
    socket.join(roomId);
    socket.roomId = roomId;

    const room = rooms[roomId];
    const playerNumber = Object.keys(room.players).length + 1;
    const isPlayer1 = playerNumber === 1;

    const defaultNames = { 1: 'Player 1', 2: 'Player 2' };
    const playerName = (playerInfo.name || '').trim().substring(0, 16) || defaultNames[playerNumber];
    const playerColor = (playerInfo.color || '').trim() || (isPlayer1 ? '#ff758c' : '#c397ff');

    room.players[socket.id] = {
        id: socket.id,
        number: playerNumber,
        name: playerName,
        color: playerColor,
        x: 340, // Centered horizontally (800 - 120) / 2
        y: isPlayer1 ? 550 : 30, // P1 at bottom, P2 at top
        width: 120,
        height: 15,
        score: 0,
    };

    socket.emit('joined', {
        roomId,
        playerId: socket.id,
        playerNumber,
        playerName,
        playerColor,
    });

    // Sync any pre-existing pictures in the room to the joining player
    socket.emit('syncImages', {
        1: room.images[1],
        2: room.images[2]
    });

    io.to(roomId).emit('state', getRoomState(room));
}

function resetBall(room) {
    room.ball.x = 400;
    room.ball.y = 300;

    const dirY = Math.random() < 0.5 ? -1 : 1;
    const dirX = Math.random() < 0.5 ? -1 : 1;
    room.ball.dx = 3 * dirX;
    room.ball.dy = 4.5 * dirY;
    room.ball.speed = Math.sqrt(room.ball.dx * room.ball.dx + room.ball.dy * room.ball.dy);
}

function awardPoint(room, scoringPlayerNumber) {
    // Find player with this number
    for (const socketId in room.players) {
        const player = room.players[socketId];
        if (player.number === scoringPlayerNumber) {
            player.score++;
            break;
        }
    }

    // Check for win condition (first to 10 points wins)
    let winnerNumber = null;
    for (const socketId in room.players) {
        const player = room.players[socketId];
        if (player.score >= 10) {
            winnerNumber = player.number;
            break;
        }
    }

    if (winnerNumber !== null) {
        room.state = 'gameover';
        room.winner = winnerNumber;
        io.to(room.id).emit('state', getRoomState(room));
    } else {
        resetBall(room);
        io.to(room.id).emit('state', getRoomState(room));
    }
}

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomId] = createRoom(roomId);
        rooms[roomId].host = socket.id;
        console.log(`Room created: ${roomId} by ${socket.id}`);
        joinPlayerToRoom(socket, roomId, data || {});
    });

    socket.on('joinRoom', (data) => {
        if (!data || !data.roomId) {
            socket.emit('errorMsg', 'Invalid room code.');
            return;
        }
        const roomId = data.roomId.trim().toUpperCase();
        const room = rooms[roomId];

        if (!room) {
            socket.emit('errorMsg', `Room code "${roomId}" not found.`);
            return;
        }

        if (Object.keys(room.players).length >= 2) {
            socket.emit('errorMsg', 'Room is full. Max 2 players.');
            return;
        }

        console.log(`Player ${socket.id} joined room ${roomId}`);
        joinPlayerToRoom(socket, roomId, data);
    });

    socket.on('startGame', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;

        if (socket.id === room.host && Object.keys(room.players).length === 2 && room.state === 'lobby') {
            console.log(`Starting game countdown in room ${roomId}`);
            room.state = 'countdown';
            room.countdown = 3;
            room.winner = null;

            for (const id in room.players) {
                room.players[id].score = 0;
            }

            // Regenerate fully random bricks on every match start!
            room.bricks = createBricks();

            io.to(roomId).emit('state', getRoomState(room));

            const countdownInterval = setInterval(() => {
                room.countdown--;
                if (room.countdown <= 0) {
                    clearInterval(countdownInterval);
                    room.state = 'playing';
                    resetBall(room);
                }
                io.to(roomId).emit('state', getRoomState(room));
            }, 1000);
        }
    });

    socket.on('restartGame', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;

        if (room.state === 'gameover') {
            room.state = 'lobby';
            room.winner = null;
            io.to(roomId).emit('state', getRoomState(room));
        }
    });

    socket.on('move', (direction) => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players[socket.id];
        if (!player) return;

        const step = 15;
        if (direction === 'left') {
            player.x -= step;
        }
        if (direction === 'right') {
            player.x += step;
        }

        player.x = Math.max(0, Math.min(800 - player.width, player.x));
        io.to(roomId).emit('state', getRoomState(room));
    });

    socket.on('moveTo', (data) => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players[socket.id];
        if (!player) return;

        player.x = data.x - player.width / 2;
        player.x = Math.max(0, Math.min(800 - player.width, player.x));
        io.to(roomId).emit('state', getRoomState(room));
    });

    socket.on('uploadImage', (data) => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players[socket.id];
        if (!player) return;

        // Save picture in room slot (1 or 2)
        room.images[data.playerNumber] = data.image;

        // Broadcast to other players in the room immediately
        socket.to(roomId).emit('imageUpdate', {
            playerNumber: data.playerNumber,
            image: data.image
        });
    });

    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;

        console.log('Player disconnected:', socket.id);
        delete room.players[socket.id];

        if (Object.keys(room.players).length === 0) {
            delete rooms[roomId];
            console.log(`Room ${roomId} deleted as it is empty.`);
        } else {
            room.state = 'lobby';
            room.winner = null;
            room.host = Object.keys(room.players)[0];

            const remainingId = room.host;
            const remainingPlayer = room.players[remainingId];
            if (remainingPlayer) {
                remainingPlayer.number = 1;
                remainingPlayer.y = 550;
                remainingPlayer.score = 0;
            }

            room.ball.x = 400;
            room.ball.y = 300;
            room.ball.dx = 0;
            room.ball.dy = 0;

            io.to(roomId).emit('state', getRoomState(room));
            io.to(roomId).emit('playerLeft', 'Opponent disconnected. You are now the host!');
        }
    });
});

function updateGame() {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room.state !== 'playing') continue;

        const ball = room.ball;

        // gradual acceleration over time
        let speed = Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy);
        speed += 0.012;
        if (speed > 13.5) speed = 13.5;

        if (speed > 0) {
            const currentSpeed = Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy);
            ball.dx = (ball.dx / currentSpeed) * speed;
            ball.dy = (ball.dy / currentSpeed) * speed;
        }

        ball.x += ball.dx;
        ball.y += ball.dy;

        // Side walls
        if (ball.x <= ball.radius) {
            ball.x = ball.radius;
            ball.dx *= -1;
        } else if (ball.x >= 800 - ball.radius) {
            ball.x = 800 - ball.radius;
            ball.dx *= -1;
        }

        if (ball.y < 0) {
            awardPoint(room, 1);
            continue;
        }

        if (ball.y > 600) {
            awardPoint(room, 2);
            continue;
        }

        // Paddle collisions
        for (const socketId in room.players) {
            const player = room.players[socketId];

            if (player.number === 1) {
                if (
                    ball.x >= player.x &&
                    ball.x <= player.x + player.width &&
                    ball.y + ball.radius >= player.y &&
                    ball.y - ball.radius <= player.y + player.height &&
                    ball.dy > 0
                ) {
                    const hitPoint = (ball.x - player.x) / player.width;
                    const angle = (hitPoint - 0.5) * (Math.PI / 2.8);

                    let currentSpeed = Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy);
                    currentSpeed += 0.3;
                    if (currentSpeed > 13.5) currentSpeed = 13.5;

                    ball.dx = currentSpeed * Math.sin(angle);
                    ball.dy = -currentSpeed * Math.cos(angle);
                    ball.y = player.y - ball.radius;
                }
            } else {
                if (
                    ball.x >= player.x &&
                    ball.x <= player.x + player.width &&
                    ball.y - ball.radius <= player.y + player.height &&
                    ball.y + ball.radius >= player.y &&
                    ball.dy < 0
                ) {
                    const hitPoint = (ball.x - player.x) / player.width;
                    const angle = (hitPoint - 0.5) * (Math.PI / 2.8);

                    let currentSpeed = Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy);
                    currentSpeed += 0.3;
                    if (currentSpeed > 13.5) currentSpeed = 13.5;

                    ball.dx = currentSpeed * Math.sin(angle);
                    ball.dy = currentSpeed * Math.cos(angle);
                    ball.y = player.y + player.height + ball.radius;
                }
            }
        }

        // Brick collisions
        let allDestroyed = true;
        for (const brick of room.bricks) {
            if (brick.destroyed) continue;
            allDestroyed = false;

            const closestX = Math.max(brick.x, Math.min(ball.x, brick.x + brick.width));
            const closestY = Math.max(brick.y, Math.min(ball.y, brick.y + brick.height));

            const distanceX = ball.x - closestX;
            const distanceY = ball.y - closestY;
            const distanceSquared = distanceX * distanceX + distanceY * distanceY;

            if (distanceSquared < ball.radius * ball.radius) {
                brick.destroyed = true;

                const overlapX = ball.radius - Math.abs(distanceX);
                const overlapY = ball.radius - Math.abs(distanceY);

                if (distanceX !== 0 && (distanceY === 0 || overlapX < overlapY)) {
                    ball.dx *= -1;
                    ball.x += distanceX > 0 ? overlapX : -overlapX;
                } else {
                    ball.dy *= -1;
                    ball.y += distanceY > 0 ? overlapY : -overlapY;
                }

                let currentSpeed = Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy);
                currentSpeed += 0.05;
                if (currentSpeed > 13.5) currentSpeed = 13.5;
                ball.dx = (ball.dx / Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy)) * currentSpeed;
                ball.dy = (ball.dy / Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy)) * currentSpeed;

                break;
            }
        }

        if (allDestroyed) {
            // Random brick layout on reset!
            room.bricks = createBricks();
            resetBall(room);
        }

        io.to(roomId).emit('state', getRoomState(room));
    }
}

setInterval(updateGame, 1000 / 60);

function getNetworkAddresses() {
    const interfaces = os.networkInterfaces();
    const addrs = {
        network: null,
        tailscale: null
    };
    for (const name in interfaces) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                if (iface.address.startsWith('100.')) {
                    addrs.tailscale = iface.address;
                } else {
                    addrs.network = iface.address;
                }
            }
        }
    }
    return addrs;
}
const addrs = getNetworkAddresses();

server.listen(3000, '0.0.0.0', () => {

    console.log('\n==================================================');
    console.log('💖 LOVELY ARKANOID SERVER IS LIVE 💖');
    console.log(`- Local access:     http://localhost:3000`);
    if (addrs.network) {
        console.log(`- Wi-Fi access:     http://${addrs.network}:3000`);
    }
    if (addrs.tailscale) {
        console.log(`- Tailscale access: http://${addrs.tailscale}:3000`);
    } else {
        console.log(`- Tailscale access: [Tailscale IP not detected - verify Tailscale is running]`);
    }
    console.log('==================================================\n');
});