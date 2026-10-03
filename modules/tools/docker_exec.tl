{
	"name": "docker_exec",
	"description": "Run a command inside a RUNNING container (argv only, no shell). Run docker_list first to get container names. Needs [docker].enabled = true",
	"arguments": [
		{
			"type": "string",
			"name": "container",
			"description": "name of a running container",
			"disallow": []
		},
		{
			"type": "string",
			"name": "command",
			"description": "command plus its args, separated by spaces, e.g. 'ls -la /app'",
			"disallow": []
		}
	]
}¤

set var res to docker.run(args.container, args.command)
if res.exitCode != 0 then
throw("command failed (exit {1}): {2}".format([res.exitCode, res.stderr + res.stdout]))
close
if res.stdout == "" then
return("(no output)")
close
return(res.stdout)
