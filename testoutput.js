const express = require('express');


const app = express().use(express.json());

app.get('/',function(req,res){
	let rando = Math.random().toString(10).substring(2, 9) + Math.random().toString(10).substring(2, 9);
	res.end(`I'm alive...random ${rando}`);
})


var port = process.env.PORT || 3000;

app.listen(port,()=>console.log(`I am Listening on ${port}`));