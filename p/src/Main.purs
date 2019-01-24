module Main where

import Prelude

import Data.Generic.Rep (class Generic)
import Data.Map (Map)
import Data.Maybe (Maybe(..))
import Data.Nullable (toNullable)
import Effect (Effect)
import Effect.Aff (launchAff_)
import Effect.Console (log)
import Foreign.Class (class Decode, class Encode)
import Foreign.Generic (defaultOptions, genericDecode, genericEncode)
import Node.HTTP (listen)
import Node.HTTP as HTTP
import Node.Websocket (ConnectionClose, ConnectionMessage, EventProxy(EventProxy), Request, on)
import Node.Websocket.Connection (remoteAddress, sendMessage)
import Node.Websocket.Request (accept, origin)
import Node.Websocket.Server (newWebsocketServer)
import Node.Websocket.Types (TextFrame(..), defaultServerConfig)
import Toppokki as T
import Data.Either (Either(..))

browserStuff :: Effect Unit
browserStuff = launchAff_ do
  browser <- T.launch {}
  page <- T.newPage browser
  T.goto (T.URL "https://example.com") page
  content <- T.content page
  _ <- T.screenshot {path: "./test/test.png"} page
  _ <- T.pdf {path: "./test/test.pdf"} page
  T.close browser

data WSRequest =
    Chase ChaseCreds
  | Bofa BofaCreds

newtype ChaseCreds = ChaseCreds { username :: String, password :: String }
newtype BofaCreds = BofaCreds { username :: String, password :: String, secretQuestionAnswers :: Map String String }

main :: Effect Unit
main = do
  httpServer <- HTTP.createServer \req resp -> log "HTTP request"
  listen
    httpServer
      { hostname: "localhost", port: 3200, backlog: Nothing } do
         log "Server listening"

  wsServer <- newWebsocketServer (defaultServerConfig httpServer)

  on request wsServer \req -> do
    log ("New connection from: " <> show (origin req))
    conn <- accept req (toNullable Nothing) (origin req)
    log "New connection accepted"
    on message conn \msg -> do
      case msg of
        Left (TextFrame {utf8Data}) ->
          log ("Received msg: " <> utf8Data)
        Right _ -> log ("Received RIGHT")

      sendMessage conn msg
    on close conn \_ _ -> do
      log ("Peer disconnected " <> remoteAddress conn)
  where
    close = EventProxy :: EventProxy ConnectionClose
    message = EventProxy :: EventProxy ConnectionMessage
    request = EventProxy :: EventProxy Request

derive instance genericChaseCreds :: Generic ChaseCreds _
derive instance genericBofaCreds :: Generic BofaCreds _
instance decodeChaseCreds :: Decode ChaseCreds where
  decode = genericDecode defaultOptions
instance encodeChaseCreds :: Encode ChaseCreds where
  encode = genericEncode defaultOptions
instance decodeBofaCreds :: Decode BofaCreds where
  decode = genericDecode defaultOptions
instance encodeBofaCreds :: Encode BofaCreds where
  encode = genericEncode defaultOptions
