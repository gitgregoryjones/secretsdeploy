const express = require('express');


const app = express().use(express.json());

app.get('/',function(req,res){
	res.end("I'm alive");
})


var port = process.env.PORT || 3000;

app.listen(port,()=>console.log(`I am Listening on ${port}`));