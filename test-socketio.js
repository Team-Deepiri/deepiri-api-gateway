const io = require('socket.io-client');

// Test direct connection to realtime-gateway
console.log('Testing direct realtime-gateway connection...');
const socket1 = io('http://localhost:5008', { transports: ['websocket'] });

socket1.on('connection_confirmed', (data) => {
  console.log('✓ Direct realtime-gateway connected:', data);
  socket1.disconnect();
  
  // Test through api-gateway proxy
  console.log('\nTesting api-gateway proxy connection...');
  const socket2 = io('http://localhost:5100', { 
    path: '/socket.io/',
    transports: ['websocket'] 
  });
  
  socket2.on('connection_confirmed', (data) => {
    console.log('✓ API Gateway proxy connected:', data);
    socket2.disconnect();
  });
  
  socket2.on('error', (err) => {
    console.log('✗ API Gateway proxy error:', err);
  });
  
  setTimeout(() => {
    if (socket2.connected) socket2.disconnect();
    process.exit(0);
  }, 5000);
});

socket1.on('error', (err) => {
  console.log('✗ Direct connection error:', err);
  process.exit(1);
});