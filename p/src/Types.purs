module Types where

import Prelude

import Data.Generic.Rep (class Generic)
import Data.Generic.Rep.Show (genericShow)
import Data.Lens (Lens', lens)
import Data.Map (Map)
import Data.Newtype (class Newtype, wrap, unwrap)
import Foreign.Class (class Decode, class Encode)
import Foreign.Generic (defaultOptions, genericDecode, genericEncode)
import Toppokki (Page, Cookie)
import Data.Argonaut (Json)
import Data.String.Regex (Regex)

newtype ChaseRequest = ChaseRequest { webhookURL :: String, creds :: ChaseCreds }
newtype ChaseCreds = ChaseCreds { username :: String, password :: String }
newtype BofaRequest = BofaRequest { webhookURL :: String, creds :: BofaCreds }
newtype BofaCreds = BofaCreds { username :: String, password :: String, secretQuestionAnswers :: Map String String }

data LoginResult =
    LoginFailed
  | LoginSucceeded
  | TwoFactorRequired

-- lenses
username :: forall n r. Newtype n { username :: String | r } => Lens' n String
username = lens (_.username <<< unwrap) $ \s b -> wrap $ _ { username = b } $ unwrap s

password :: forall n r. Newtype n { password :: String | r } => Lens' n String
password = lens (_.password <<< unwrap) $ \s b -> wrap $ _ { password = b } $ unwrap s

data State =
    AttemptingLogin Int Page Regex
  | LoggedIn (Array Cookie)

data ScrapeResult =
    Success (Array Json)
  | Failure

derive instance genericChaseRequest :: Generic ChaseRequest _
derive instance genericChaseCreds :: Generic ChaseCreds _
derive instance newtypeChaseCreds :: Newtype ChaseCreds _
derive instance genericBofaCreds :: Generic BofaCreds _
derive instance genericBofaRequest :: Generic BofaRequest _
instance decodeChaseRequest :: Decode ChaseRequest where
  decode = genericDecode defaultOptions
instance encodeChaseRequest :: Encode ChaseRequest where
  encode = genericEncode defaultOptions
instance decodeChaseCreds :: Decode ChaseCreds where
  decode = genericDecode defaultOptions
instance encodeChaseCreds :: Encode ChaseCreds where
  encode = genericEncode defaultOptions
instance decodeBofaRequest :: Decode BofaRequest where
  decode = genericDecode defaultOptions
instance encodeBofaRequest :: Encode BofaRequest where
  encode = genericEncode defaultOptions
instance decodeBofaCreds :: Decode BofaCreds where
  decode = genericDecode defaultOptions
instance encodeBofaCreds :: Encode BofaCreds where
  encode = genericEncode defaultOptions

derive instance eqLoginResult :: Eq LoginResult
derive instance genericLoginResult :: Generic LoginResult _
instance showLoginResult :: Show LoginResult where
  show = genericShow
