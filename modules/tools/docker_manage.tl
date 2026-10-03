{
	"name": "docker_manage",
	"description": "Start, stop, restart or remove an existing container. Needs [docker].enabled = true",
	"arguments": [
		{
			"type": "string",
			"name": "container",
			"description": "container name (see docker_list)",
			"disallow": []
		},
		{
			"type": "string",
			"name": "action",
			"description": "one of: start, stop, restart, remove",
			"disallow": []
		}
	]
}¤

set var res to null
if args.action == "start" then
res = docker.start(args.container)
if res.exitCode != 0 then
throw("start failed: {1}".format([res.stderr]))
close
return("started {1}".format([args.container]))
close
if args.action == "stop" then
res = docker.stop(args.container)
if res.exitCode != 0 then
throw("stop failed: {1}".format([res.stderr]))
close
return("stopped {1}".format([args.container]))
close
if args.action == "restart" then
res = docker.restart(args.container)
if res.exitCode != 0 then
throw("restart failed: {1}".format([res.stderr]))
close
return("restarted {1}".format([args.container]))
close
if args.action == "remove" then
res = docker.remove(args.container)
if res.exitCode != 0 then
throw("remove failed: {1}".format([res.stderr]))
close
return("removed {1}".format([args.container]))
close
throw("docker_manage: action must be one of start, stop, restart, remove")
