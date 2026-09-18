@echo off
echo:
echo 正在启动本地中继服务器
echo 需要Java8或更新！
echo 本地中继服务器地址：ws://127.0.0.1:12345
:fuck
echo:
java -jar EaglerSPRelay.jar --debug
echo:
echo RELAY STOPPED!
echo Restarting...
goto fuck